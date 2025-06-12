import type {
  BaseParams,
  Context,
  DppOptions,
  ExtOptions,
  Plugin,
  ProtocolName,
} from "jsr:@shougo/dpp-vim@~4.3.0/types";
import { type Action, BaseExt } from "jsr:@shougo/dpp-vim@~4.3.0/ext";
import type { Protocol } from "jsr:@shougo/dpp-vim@~4.3.0/protocol";
import {
  convert2List,
  isDirectory,
  printError,
  safeStat,
} from "jsr:@shougo/dpp-vim@~4.3.0/utils";

import type { Denops } from "jsr:@denops/std@~7.5.0";
import { batch } from "jsr:@denops/std@~7.5.0/batch";
import * as autocmd from "jsr:@denops/std@~7.5.0/autocmd";
import * as op from "jsr:@denops/std@~7.5.0/option";
import * as fn from "jsr:@denops/std@~7.5.0/function";
import * as vars from "jsr:@denops/std@~7.5.0/variable";

import { expandGlob } from "jsr:@std/fs@~1.0.1/expand-glob";
import { delay } from "jsr:@std/async@~1.0.3/delay";
import { TextLineStream } from "jsr:@std/streams@~1.0.1/text-line-stream";
import { Semaphore } from "jsr:@core/asyncutil@~1.2.0/semaphore";

export type Params = {
  checkDiff: boolean;
  enableDenoCache: boolean;
  githubAPIToken: string;
  logFilePath: string;
  maxProcesses: number;
  wait: number;
};

export type Attrs = {
  installerBuild?: string;
  installerFrozen?: boolean;
};

export type InstallParams = {
  names?: string[];
  rollback?: string;
};

export type CheckNotUpdatedParams = {
  names?: string[];
  force?: boolean;
};

type UpdatedPlugin = {
  plugin: Plugin;
  protocol: Protocol;
  newRev: string;
  oldRev: string;
  url: string;
  logMessage: string;
  changesCount: number;
};

type Rollbacks = Record<string, string>;

export type ExtActions<Params extends BaseParams> = {
  build: Action<Params, void>;
  checkNotUpdated: Action<Params, void>;
  denoCache: Action<Params, void>;
  getNotInstalled: Action<Params, Plugin[]>;
  getNotUpdated: Action<Params, Plugin[]>;
  getFailed: Action<Params, Plugin[]>;
  getLogs: Action<Params, string[]>;
  getUpdateLogs: Action<Params, string[]>;
  getUpdated: Action<Params, Plugin[]>;
  install: Action<Params, void>;
  reinstall: Action<Params, void>;
  update: Action<Params, void>;
};

export class Ext extends BaseExt<Params> {
  #failedPlugins: Plugin[] = [];
  #logs: string[] = [];
  #updateLogs: string[] = [];
  #updatedPlugins: Plugin[] = [];

  override async onInit(args: {
    denops: Denops;
  }) {
    await autocmd.group(args.denops, "dpp", (helper: autocmd.GroupHelper) => {
      helper.define(
        "User",
        "Dpp:ext:installer:updateDone",
        ":",
      );
    });
  }

  override actions: ExtActions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        const sem = new Semaphore(args.extParams.maxProcesses);
        await Promise.all(plugins.map((plugin) =>
          sem.lock(async () => {
            await this.#buildPlugin(args.denops, args.extParams, plugin);
          })
        ));
      },
    },
    checkNotUpdated: {
      description: "Check not updated plugins",
      callback: async (args: {
        denops: Denops;
        context: Context;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extOptions: ExtOptions;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as CheckNotUpdatedParams;

        const updatedPlugins = Array.from(
          new Set(
            (await this.#checkUpdatedPlugins(
              args,
              await getPlugins(args.denops, params.names ?? []),
            )).concat(await this.actions.getNotInstalled.callback(args)).map((
              plugin,
            ) => plugin.name),
          ),
        ).sort();

        if (updatedPlugins.length === 0) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            "updated plugins are not found.",
          );
          return;
        }

        const force = params.force ?? false;
        if (!force) {
          const updatedText = (updatedPlugins.length > 10)
            ? updatedPlugins.slice(0, 10).join("\n") + "\n..."
            : updatedPlugins.join("\n");
          if (
            await fn.confirm(
              args.denops,
              `Updated plugins:\n${updatedText}\n\nUpdate now?`,
              "yes\nNo",
              2,
            ) !== 1
          ) {
            return;
          }
        }

        const plugins = await getPlugins(args.denops, updatedPlugins);
        await this.#updatePlugins(args, plugins, {});
      },
    },
    denoCache: {
      description: "Execute deno cache for plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        await this.#denoCachePlugins(args.denops, args.extParams, plugins);
      },
    },
    getNotInstalled: {
      description: "Get not installed plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        return plugins.filter((_) => bits.shift());
      },
    },
    getNotUpdated: {
      description: "Get not updated plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await this.#checkUpdatedPlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        );

        return plugins;
      },
    },
    getFailed: {
      description: "Get failed plugins",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#failedPlugins;
      },
    },
    getLogs: {
      description: "Get logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#logs;
      },
    },
    getUpdateLogs: {
      description: "Get update logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#updateLogs;
      },
    },
    getUpdated: {
      description: "Get updated plugins",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#updatedPlugins;
      },
    },
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        await this.#updatePlugins(
          args,
          plugins.filter((_) => bits.shift()),
          revisions,
        );
      },
    },
    reinstall: {
      description: "Reinstall plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        if (!params.names || params.names.length === 0) {
          // NOTE: names must be set.
          await this.#printError(
            args.denops,
            args.extParams,
            "names must be set for reinstall plugins.",
          );
          return;
        }

        const plugins = await getPlugins(args.denops, params.names ?? []);

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

        await Promise.all(plugins.map(async (plugin) => {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            await Deno.remove(plugin.path, { recursive: true });
          }
        }));

        await this.#updatePlugins(args, plugins, revisions);
      },
    },
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

        await this.#updatePlugins(args, plugins, revisions);
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
      enableDenoCache: true,
      githubAPIToken: "",
      logFilePath: "",
      maxProcesses: 5,
      wait: 0,
    };
  }

  async #updatePlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    plugins: Plugin[],
    revisions: Record<string, string>,
  ) {
    this.#failedPlugins = [];
    this.#logs = [];
    this.#updatedPlugins = [];
    this.#updateLogs = [];

    if (plugins.length === 0) {
      await this.#printError(
        args.denops,
        args.extParams,
        "Target plugins are not found.",
      );
      await this.#printError(
        args.denops,
        args.extParams,
        "You may have used the wrong plugin name," +
          " or all of the plugins are already installed.",
      );

      await args.denops.cmd(
        "doautocmd User Dpp:ext:installer:updateDone",
      );

      return;
    }

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Start: ${new Date()}`,
    );

    const updatedPlugins: UpdatedPlugin[] = [];
    const failedPlugins: Plugin[] = [];
    const sem = new Semaphore(args.extParams.maxProcesses);
    await Promise.all(plugins.map((plugin, index) =>
      sem.lock(async () => {
        await this.#updatePlugin(
          args,
          updatedPlugins,
          failedPlugins,
          revisions,
          plugins.length,
          plugin,
          index + 1,
        );

        if (args.extParams.wait > 0) {
          await delay(args.extParams.wait);
        }
      })
    ));

    if (args.extParams.enableDenoCache && updatedPlugins) {
      await this.#denoCachePlugins(
        args.denops,
        args.extParams,
        updatedPlugins.map(({ plugin }) => plugin),
      );
    }

    const calledDepends: Record<string, boolean> = {};
    for (const updated of updatedPlugins) {
      if (updated.plugin.hook_done_update) {
        await args.denops.call(
          "dpp#ext#installer#_call_hook",
          "done_update",
          updated.plugin,
        );
      }

      for (
        const depend of await getPlugins(
          args.denops,
          convert2List(updated.plugin.depends),
        )
      ) {
        if (depend.hook_depends_update && !calledDepends[depend.name]) {
          calledDepends[depend.name] = true;

          await args.denops.call(
            "dpp#ext#installer#_call_hook",
            "depends_update",
            depend,
          );
        }
      }

      if (args.extParams.checkDiff) {
        await this.#checkDiff(
          args.denops,
          args.extParams,
          updated.plugin,
          updated.protocol,
          updated.oldRev,
          updated.newRev,
        );
      }
    }

    if (updatedPlugins.length > 0) {
      const formatPlugin = (updated: UpdatedPlugin): string => {
        const compareLink =
          updated.oldRev !== "" && /^https?:\/\/github.com\//.test(updated.url)
            ? `\n    ${
              updated.url.replace(/\.git$/, "").replace(/^\w+:/, "https:")
            }/compare/${updated.oldRev}...${updated.newRev}`
            : "";
        const changes = updated.changesCount === 0
          ? ""
          : `(${updated.changesCount} change${
            updated.changesCount === 1 ? "" : "s"
          })`;
        return `  ${updated.plugin.name}${changes}${compareLink}`;
      };

      await this.#printMessage(
        args.denops,
        args.extParams,
        "Updated plugins:\n" +
          `${
            updatedPlugins.map((updated) => formatPlugin(updated)).join("\n")
          }`,
      );

      // If it has breaking changes commit message
      // https://www.conventionalcommits.org/en/v1.0.0/
      const breakingPlugins = updatedPlugins.filter(
        (updated) => updated.logMessage.match(/.*!.*:|BREAKING CHANGE:/),
      );

      if (breakingPlugins.length > 0) {
        await this.#printMessage(
          args.denops,
          args.extParams,
          "Breaking updated plugins:\n" +
            `${
              breakingPlugins.map((updated) => "    " + updated.plugin.name)
                .join("\n")
            }`,
        );
      }

      await saveRollbackFile(args.denops, args.protocols);
    }

    if (failedPlugins.length > 0) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        "Failed plugins:\n" +
          `${failedPlugins.map((plugin) => plugin.name).join("\n")}\n` +
          "Please read the error message log with the :message command.",
      );
    }

    this.#updatedPlugins = updatedPlugins.map((plugin) => plugin.plugin);
    this.#failedPlugins = failedPlugins;

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    await args.denops.call("dpp#make_state");

    // NOTE: "redraw" is needed to close popup window
    await args.denops.cmd("redraw");

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Done: ${new Date()}`,
    );

    await args.denops.cmd(
      "doautocmd User Dpp:ext:installer:updateDone",
    );
  }

  async #updatePlugin(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    updatedPlugins: UpdatedPlugin[],
    failedPlugins: Plugin[],
    revisions: Record<string, string>,
    maxLength: number,
    plugin: Plugin,
    index: number,
  ) {
    await this.#printProgress(
      args.denops,
      args.extParams,
      `[${index}/${maxLength}] ${plugin.name}`,
    );

    const protocol = args.protocols[plugin.protocol ?? ""];

    const oldRev = await protocol.protocol.getRevision({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    if (plugin.rev) {
      // Force checkout HEAD revision.
      // The repository may be checked out.
      const saveRev = plugin.rev;

      plugin.rev = "";

      await this.#revisionLockPlugin(
        args.denops,
        args.extParams,
        plugin,
        protocol,
      );

      plugin.rev = saveRev;
    }

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    if (revisions[plugin.name]) {
      // Add rollback commands
      commands.push(
        ...await protocol.protocol.getRollbackCommands({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          rev: revisions[plugin.name],
        }),
      );
    }

    // Execute commands
    let updateSuccess = true;
    for (const command of commands) {
      const { stdout, stderr, status } = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();

      pipeStream(
        stdout,
        this.#printProgress.bind(this, args.denops, args.extParams),
      );
      pipeStream(
        stderr,
        this.#printError.bind(this, args.denops, args.extParams),
      );

      const { success } = await status;
      if (!success) {
        updateSuccess = false;
        break;
      }
    }

    if (plugin.rev) {
      // Restore revision
      await this.#revisionLockPlugin(
        args.denops,
        args.extParams,
        plugin,
        protocol,
      );
    }

    if (updateSuccess) {
      const newRev = await protocol.protocol.getRevision({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      const logMessage = await this.#getLogMessage(
        args.denops,
        args.extParams,
        plugin,
        protocol,
        oldRev,
        newRev,
      );

      const changesCount = await this.#getChangesCount(
        args.denops,
        args.extParams,
        plugin,
        protocol,
        oldRev,
        newRev,
      );

      if (oldRev.length === 0 || oldRev !== newRev) {
        // Execute "post_update" before "build"
        if (plugin.hook_post_update) {
          await args.denops.call(
            "dpp#ext#installer#_call_hook",
            "post_update",
            plugin,
          );
        }

        await this.#buildPlugin(args.denops, args.extParams, plugin);

        const url = await protocol.protocol.getUrl({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
        });

        updatedPlugins.push({
          plugin,
          protocol,
          oldRev,
          newRev,
          url,
          logMessage,
          changesCount,
        });
      }
    } else {
      failedPlugins.push(plugin);
    }
  }

  async #checkUpdatedPlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      extParams: Params;
    },
    plugins: Plugin[],
  ): Promise<Plugin[]> {
    if (plugins.length === 0) {
      await this.#printError(
        args.denops,
        args.extParams,
        "Target plugins are not found.",
      );
      await this.#printError(
        args.denops,
        args.extParams,
        "You may have used the wrong plugin name," +
          " or all of the plugins are already installed.",
      );
      return [];
    }

    if (args.extParams.githubAPIToken.length === 0) {
      await this.#printError(
        args.denops,
        args.extParams,
        '"githubAPIToken" must be set.',
      );
      return [];
    }

    // Get the last updated time by rollbackfile timestamp.
    const basePath = await vars.g.get(args.denops, "dpp#_base_path");
    const name = await vars.g.get(args.denops, "dpp#_name");
    const rollbackDir = `${basePath}/${name}/rollbacks/latest`;
    const rollbackFile = `${rollbackDir}/rollback.json`;
    const rollbackStat = await safeStat(rollbackFile);
    const baseUpdated = rollbackStat ? rollbackStat.mtime : null;

    if (!baseUpdated) {
      // Not updated yet.
      return plugins;
    }

    // Create query string.
    const query = "query {\n" +
      [...plugins.entries()].flatMap(([index, plugin]) => {
        if (!plugin.repo) return [];
        const [owner, name] = extractGitHubRepo(plugin.repo) ?? [];
        if (!owner || !name) return [];
        // NOTE: "repository" API is faster than "search" API
        return [
          `repo${index}: repository(owner:"${owner}", name:"${name}"){ pushedAt }`,
        ];
      }).join("\n") + "\n}";

    // POST github API
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${args.extParams.githubAPIToken}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      await this.#printError(
        args.denops,
        args.extParams,
        `Failed to fetch from GitHub GraphQL API: ${resp.statusText}`,
      );
      return [];
    }

    const result = await resp.json() as
      | { data: Record<string, { pushedAt: string }> }
      | { errors: { message: string }[] };

    if ("errors" in result) {
      await this.#printError(
        args.denops,
        args.extParams,
        `Failed to fetch from GitHub GraphQL API: ${result.errors[0].message}`,
      );
      return [];
    }

    return plugins.filter((_, index) =>
      result.data[`repo${index}`]?.pushedAt &&
      new Date(result.data[`repo${index}`].pushedAt) > baseUpdated
    );
  }

  async #getLogMessage(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ): Promise<string> {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return "";
    }

    const commands = await protocol.protocol.getLogCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    const logMessage: string[] = [];
    for (const command of commands) {
      const { stdout, stderr, status } = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();

      await pipeStream(stdout, (msg) => logMessage.push(msg));
      await pipeStream(stderr, this.#printError.bind(this, denops, extParams));
      await status;
    }

    return logMessage.join("\n");
  }

  async #getChangesCount(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ): Promise<number> {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return 0;
    }

    const commands = await protocol.protocol.getChangesCountCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    let changesCount = 0;
    for (const command of commands) {
      const { stdout, stderr, status } = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();

      await pipeStream(stdout, (msg) => changesCount = parseInt(msg, 10));
      await pipeStream(stderr, this.#printError.bind(this, denops, extParams));
      await status;
    }

    return changesCount;
  }

  async #buildPlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
  ) {
    const build = (plugin.extAttrs as Attrs)?.installerBuild;
    if (!plugin.path || !await isDirectory(plugin.path) || !build) {
      return;
    }

    const { stdout, stderr, status } = new Deno.Command(
      await op.shell.getGlobal(denops),
      {
        args: [await op.shellcmdflag.getGlobal(denops), build],
        cwd: plugin.path,
        stdout: "piped",
        stderr: "piped",
      },
    ).spawn();

    pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
    pipeStream(stderr, this.#printError.bind(this, denops, extParams));
    await status;
  }

  async #denoCachePlugins(
    denops: Denops,
    extParams: Params,
    plugins: Plugin[],
  ) {
    if (!await fn.executable(denops, "deno")) {
      return;
    }
    const entries = await Promise.all(plugins.map(async (plugin) => {
      if (!plugin.path || !await isDirectory(`${plugin.path}/denops`)) {
        return [];
      }
      return await Array.fromAsync(
        expandGlob(`${plugin.path}/denops/**/*.ts`),
      );
    }));
    const files = entries.flatMap((files) => files.map(({ path }) => path));
    if (!files.length) {
      return;
    }

    // Execute "deno cache" to optimize
    const { stdout, stderr, status } = new Deno.Command(
      "deno",
      {
        args: ["cache", "--no-check", "--reload"].concat(files),
        env: { NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      },
    ).spawn();

    pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
    pipeStream(stderr, this.#printError.bind(this, denops, extParams));
    await status;
  }

  async #revisionLockPlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
  ) {
    if (!plugin.path || !await isDirectory(plugin.path) || !plugin.rev) {
      return;
    }

    const commands = await protocol.protocol.getRevisionLockCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    for (const command of commands) {
      const { stdout, stderr, status } = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();

      pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
      pipeStream(stderr, this.#printError.bind(this, denops, extParams));
      await status;
    }
  }

  async #checkDiff(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ) {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return;
    }

    const commands = await protocol.protocol.getDiffCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    for (const command of commands) {
      const output: string[] = [];
      const { stdout, stderr, status } = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();

      pipeStream(stdout, (msg) => msg && output.push(msg));
      pipeStream(stderr, this.#printError.bind(this, denops, extParams));
      await status.then(() => outputCheckDiff(denops, output));
    }
  }

  async #printError(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    if (msg.includes("fatal: could not read Username for ")) {
      // NOTE: It is github's invalid repository error message.
      await printError(denops, "Target repository name is invalid.");
      await printError(denops, "You may have used the wrong plugin name.");
    }

    await printError(denops, msg);
    this.#updateLogs.push(msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #printMessage(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    await denops.call("dpp#ext#installer#_print_message", msg);
    this.#updateLogs.push(msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #printProgress(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    await denops.call("dpp#ext#installer#_print_progress_message", msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #outputLogFile(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    if (protocolParams.logFilePath.length === 0) {
      return;
    }

    const logFilePath = await denops.call(
      "dpp#util#_expand",
      protocolParams.logFilePath,
    ) as string;
    await Deno.writeTextFile(logFilePath, `${msg}\n`, { append: true });
  }
}

async function getPlugins(
  denops: Denops,
  names: string[],
): Promise<Plugin[]> {
  // NOTE: Skip local plugins
  let plugins = (Object.values(
    await vars.g.get(
      denops,
      "dpp#_plugins",
    ),
  ) as Plugin[]).filter((plugin) =>
    !plugin.local && !(plugin.extAttrs as Attrs)?.installerFrozen
  );

  if (names.length > 0) {
    plugins = plugins.filter((plugin) => names.indexOf(plugin.name) >= 0);
  }

  return plugins;
}

async function outputCheckDiff(denops: Denops, output: string[]) {
  if (output.length === 0) {
    return;
  }

  const bufname = "dpp-diff";
  const bufnr = await fn.bufexists(denops, bufname)
    ? await fn.bufnr(denops, bufname)
    : await fn.bufadd(denops, bufname);

  if (
    await fn.bufwinnr(denops, bufnr) < 0 && await fn.bufexists(denops, bufnr)
  ) {
    const winId = await fn.win_getid(denops);

    const cmd =
      "setlocal bufhidden=wipe filetype=diff buftype=nofile nolist | syntax enable"
        .replaceAll(" ", "\\ ");
    await denops.cmd(`sbuffer +${cmd} ${bufnr}`);

    // Restore the cursor
    await fn.win_gotoid(denops, winId);
  }

  await batch(denops, async (denops: Denops) => {
    await fn.setbufvar(denops, bufnr, "&modifiable", true);
    await fn.appendbufline(denops, bufnr, "$", output);
    await fn.setbufvar(denops, bufnr, "&modifiable", false);
  });
}

async function saveRollbackFile(
  denops: Denops,
  protocols: Record<ProtocolName, Protocol>,
) {
  // Get revisions
  const revisions: Rollbacks = {};
  for (const plugin of await getPlugins(denops, [])) {
    const protocol = protocols[plugin.protocol ?? ""];
    revisions[plugin.name] = await protocol.protocol.getRevision({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });
  }

  const getFormattedDate = (date: Date): string => {
    const year = date.getFullYear().toString().slice(-2);
    const month = ("0" + (date.getMonth() + 1)).slice(-2);
    const day = ("0" + date.getDate()).slice(-2);
    const hours = ("0" + date.getHours()).slice(-2);
    const minutes = ("0" + date.getMinutes()).slice(-2);
    const seconds = ("0" + date.getSeconds()).slice(-2);

    return year + month + day + hours + minutes + seconds;
  };

  // Save rollback file
  const basePath = await vars.g.get(denops, "dpp#_base_path");
  const name = await vars.g.get(denops, "dpp#_name");
  for (const date of ["latest", getFormattedDate(new Date())]) {
    const rollbackDir = `${basePath}/${name}/rollbacks/${date}`;
    await Deno.mkdir(rollbackDir, { recursive: true });
    const rollbackFile = `${rollbackDir}/rollback.json`;
    await Deno.writeTextFile(rollbackFile, JSON.stringify(revisions));
  }
}

async function loadRollbackFile(
  denops: Denops,
  date: string,
): Promise<Record<string, string>> {
  // Get revisions

  // Save rollback file
  const basePath = await vars.g.get(denops, "dpp#_base_path");
  const name = await vars.g.get(denops, "dpp#_name");
  const rollbackDir = `${basePath}/${name}/rollbacks/${date}`;
  const rollbackFile = `${rollbackDir}/rollback.json`;
  if (!await safeStat(rollbackFile)) {
    return {};
  }

  return JSON.parse(await Deno.readTextFile(rollbackFile)) as Rollbacks;
}

function pipeStream(
  stream: ReadableStream<Uint8Array>,
  writer: (msg: string) => unknown | Promise<unknown>,
): Promise<void> {
  return stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream({ allowCR: true }))
    .pipeTo(
      new WritableStream({
        write: async (chunk) => {
          await writer(chunk);
        },
      }),
    );
}

function extractGitHubRepo(repo: string): [string, string] | undefined {
  if (repo.startsWith("https://github.com/")) {
    // https://github.com/ style
    const [owner, name] = repo.slice(19).split("/");
    return [owner, name.replace(/\.git$/, "")];
  } else if (repo.startsWith("github.com/")) {
    // github.com/ style
    const [owner, name] = repo.slice(11).split("/");
    return [owner, name.replace(/\.git$/, "")];
  } else if (repo.startsWith("git@github.com:")) {
    // git@github.com: style
    const [owner, name] = repo.slice(15).split("/");
    return [owner, name.replace(/\.git$/, "")];
  }

  const splitted = repo.split("/");
  if (splitted.length === 2) {
    // owner/name style
    const [owner, name] = splitted;
    return [owner, name.replace(/\.git$/, "")];
  }

  return undefined;
}
