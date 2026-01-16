import type {
  BaseParams,
  Context,
  DppOptions,
  ExtOptions,
  Plugin,
  ProtocolName,
} from "@shougo/dpp-vim/types";
import { type Action, BaseExt } from "@shougo/dpp-vim/ext";
import type { Protocol } from "@shougo/dpp-vim/protocol";
import {
  convert2List,
  isDirectory,
  printError,
  safeStat,
} from "@shougo/dpp-vim/utils";

import type { Denops } from "@denops/std";
import { batch } from "@denops/std/batch";
import * as autocmd from "@denops/std/autocmd";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";

import { delay } from "@std/async/delay";
import { TextLineStream } from "@std/streams/text-line-stream";
import { Semaphore } from "@core/asyncutil/semaphore";

export type Params = {
  checkDiff: boolean;
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

export type CheckParams = {
  force?: boolean;
  names?: string[];
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

type CheckUpdatedPlugin = {
  count?: number;
  plugin: Plugin;
  updated?: Date;
};

type Rollbacks = Record<string, string>;

export type ExtActions<Params extends BaseParams> = {
  build: Action<Params, void>;
  checkNotUpdated: Action<Params, void>;
  checkRemoteUpdated: Action<Params, void>;
  denoCache: Action<Params, void>;
  getFailed: Action<Params, Plugin[]>;
  getLogs: Action<Params, string[]>;
  getNotInstalled: Action<Params, Plugin[]>;
  getNotUpdated: Action<Params, Plugin[]>;
  getRemoteUpdated: Action<Params, Plugin[]>;
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
        const params = args.actionParams as CheckParams;

        const checked = await this.#checkGithubUpdatedPlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        );

        const notInstalled = await this.actions.getNotInstalled.callback(args);

        const map = new Map<string, CheckUpdatedPlugin>();
        for (const cp of checked) {
          map.set(cp.plugin.name, cp);
        }
        for (const p of notInstalled) {
          if (!map.has(p.name)) {
            map.set(p.name, { plugin: p });
          }
        }

        const updatedPlugins: CheckUpdatedPlugin[] = Array.from(
          map.values(),
        ).sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

        if (updatedPlugins.length === 0) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            "Updated plugins are not found.",
          );
          return;
        }

        if (!params.force) {
          const check = await this.#displayUpdatedPlugins(
            args.denops,
            updatedPlugins,
          );
          if (!check) {
            return;
          }
        }

        const plugins = await getPlugins(
          args.denops,
          updatedPlugins.map((updated) => updated.plugin.name),
        );
        await this.#updatePlugins(args, plugins, {});
      },
    },
    checkRemoteUpdated: {
      description: "Check remote updated plugins",
      callback: async (args: {
        denops: Denops;
        context: Context;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extOptions: ExtOptions;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as CheckParams;

        const checked: CheckUpdatedPlugin[] = (await this.#checkRemotePlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        )).sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

        const notInstalled = await this.actions.getNotInstalled.callback(args);

        const map = new Map<string, CheckUpdatedPlugin>();
        for (const cp of checked) {
          map.set(cp.plugin.name, cp);
        }
        for (const p of notInstalled) {
          if (!map.has(p.name)) {
            map.set(p.name, { plugin: p });
          }
        }

        const updatedPlugins: CheckUpdatedPlugin[] = Array.from(
          map.values(),
        ).sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

        if (updatedPlugins.length === 0) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            "Updated plugins are not found.",
          );
          return;
        }

        if (!params.force) {
          const check = await this.#displayUpdatedPlugins(
            args.denops,
            updatedPlugins,
          );
          if (!check) {
            return;
          }
        }

        const plugins = await getPlugins(
          args.denops,
          updatedPlugins.map((updated) => updated.plugin.name),
        );
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
        const plugins = (await this.#checkUpdatedPlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        )).map((updated) => updated.plugin);

        return plugins;
      },
    },
    getRemoteUpdated: {
      description: "Get remote updated plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = (await this.#checkRemotePlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        )).map((updated) => updated.plugin);

        return plugins;
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

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

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

        await this.#updatePlugins(
          args,
          plugins.filter((plugin) =>
            !(plugin.extAttrs as Attrs)?.installerFrozen
          ),
          revisions,
        );
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
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

    if (plugin.local) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        `"${plugin.name}" is local plugin.  The update is skipped.`,
      );

      return;
    }

    const protocolName = plugin.protocol ?? "";
    if (protocolName.length === 0) {
      return;
    }
    const protocol = args.protocols[protocolName];

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

    if (plugin.hook_pre_update) {
      await args.denops.call(
        "dpp#ext#installer#_call_hook",
        "pre_update",
        plugin,
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

  async #checkRemotePlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    plugins: Plugin[],
  ): Promise<CheckUpdatedPlugin[]> {
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

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Start: ${new Date()}`,
    );

    const updatedPlugins: UpdatedPlugin[] = [];
    const sem = new Semaphore(args.extParams.maxProcesses);
    await Promise.all(plugins.map((plugin, index) =>
      sem.lock(async () => {
        await this.#checkRemotePlugin(
          args,
          updatedPlugins,
          plugins.length,
          plugin,
          index + 1,
        );

        if (args.extParams.wait > 0) {
          await delay(args.extParams.wait);
        }
      })
    ));

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
    }

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    // NOTE: "redraw" is needed to close popup window
    await args.denops.cmd("redraw");

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Done: ${new Date()}`,
    );

    return updatedPlugins.map((plugin) => {
      return { plugin: plugin.plugin, count: plugin.changesCount };
    });
  }

  async #checkRemotePlugin(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    updatedPlugins: UpdatedPlugin[],
    maxLength: number,
    plugin: Plugin,
    index: number,
  ) {
    await this.#printProgress(
      args.denops,
      args.extParams,
      `[${index}/${maxLength}] ${plugin.name}`,
    );

    if (plugin.local) {
      return;
    }

    const protocolName = plugin.protocol ?? "";
    if (protocolName.length === 0) {
      return;
    }
    const protocol = args.protocols[protocolName];

    const commands = await protocol.protocol.getCheckRemoteCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    // Execute commands
    let updateSuccess = true;
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
      await pipeStream(
        stderr,
        this.#printError.bind(this, args.denops, args.extParams),
      );

      const { success } = await status;
      if (!success) {
        updateSuccess = false;
        break;
      }
    }

    if (updateSuccess && logMessage.length > 0) {
      const url = await protocol.protocol.getUrl({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      const oldRev = await protocol.protocol.getRevision({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      const newRev = await protocol.protocol.getRemoteRevision({
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
        logMessage: logMessage.join("\n"),
        changesCount: logMessage.length,
      });
    }
  }

  async #checkGithubUpdatedPlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      extParams: Params;
    },
    plugins: Plugin[],
  ): Promise<CheckUpdatedPlugin[]> {
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
      return [];
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

    return plugins
      .map((plugin, index) => {
        const pushedAt = result?.data?.[`repo${index}`]?.pushedAt;
        const updated = pushedAt ? new Date(pushedAt) : undefined;
        if (updated && updated > baseUpdated) {
          return { plugin, updated } as CheckUpdatedPlugin;
        }
        return undefined;
      }).filter((p): p is CheckUpdatedPlugin => p !== undefined);
  }

  async #checkUpdatedPlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      extParams: Params;
    },
    plugins: Plugin[],
  ): Promise<CheckUpdatedPlugin[]> {
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
      return [];
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

    return plugins
      .map((plugin, index) => {
        const pushedAt = result?.data?.[`repo${index}`]?.pushedAt;
        const updated = pushedAt ? new Date(pushedAt) : undefined;
        if (updated && updated > baseUpdated) {
          return { plugin, updated } as CheckUpdatedPlugin;
        }
        return undefined;
      }).filter((p): p is CheckUpdatedPlugin => p !== undefined);
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

    // Execute "deno cache" to optimize
    for (const plugin of plugins) {
      if (
        !plugin.path || !await isDirectory(`${plugin.path}/denops`) ||
        plugin.name === "denops.vim"
      ) {
        continue;
      }

      const { stdout, stderr, status } = new Deno.Command(
        "deno",
        {
          args: ["cache", "--no-check", "--reload", "."],
          env: { NO_COLOR: "1" },
          stdout: "piped",
          stderr: "piped",
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
        },
      ).spawn();

      pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
      pipeStream(stderr, this.#printError.bind(this, denops, extParams));
      await status;
    }
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

  async #displayUpdatedPlugins(
    denops: Denops,
    updatedPlugins: CheckUpdatedPlugin[],
  ): Promise<boolean> {
    function timeAgo(d: Date, now = new Date()): string {
      const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
      if (diffSec < 0) return "just now";
      if (diffSec < 60) {
        const s = diffSec;
        return `${s} second${s === 1 ? "" : "s"} ago`;
      }
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        const m = diffMin;
        return `${m} minute${m === 1 ? "" : "s"} ago`;
      }
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) {
        const h = diffHour;
        return `${h} hour${h === 1 ? "" : "s"} ago`;
      }
      const diffDay = Math.floor(diffHour / 24);
      if (diffDay < 30) {
        const d = diffDay;
        return `${d} day${d === 1 ? "" : "s"} ago`;
      }
      const diffMonth = Math.floor(diffDay / 30);
      if (diffMonth < 12) {
        const mo = diffMonth;
        return `${mo} month${mo === 1 ? "" : "s"} ago`;
      }
      const diffYear = Math.floor(diffDay / 365);
      const y = diffYear;
      return `${y} year${y === 1 ? "" : "s"} ago`;
    }

    // "YYYY-MM-DD HH:MM:SS"
    const formatDate = (d: Date) =>
      d.toISOString().replace("T", " ").slice(0, 19);

    const sorted = [...updatedPlugins].sort(
      (a, b) => a.plugin.name.localeCompare(b.plugin.name),
    );
    const maxNameLen = sorted.reduce(
      (m, p) => Math.max(m, p.plugin.name.length),
      0,
    );

    const lines = sorted.map((p) => {
      const name = p.plugin.name.padEnd(maxNameLen);
      if (p.updated) {
        return `${name}: ${formatDate(p.updated)} (${timeAgo(p.updated)})`;
      } else if (p.count) {
        return `${name}: (${p.count} change${p.count === 1 ? "" : "s"})`;
      } else {
        return `${name}`;
      }
    });

    const displayedLines = lines.length > 10
      ? [...lines.slice(0, 10), "..."]
      : lines;
    const prompt = [
      ...displayedLines,
    ].join("\n");

    return await fn.confirm(
      denops,
      `${prompt}\n\nUpdate now?`,
      "yes\nNo",
      2,
    ) === 1;
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
  let plugins = Object.values(
    await vars.g.get(
      denops,
      "dpp#_plugins",
    ),
  ) as Plugin[];

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
    const protocolName = plugin.protocol ?? "";
    if (protocolName.length === 0) {
      continue;
    }
    const protocol = protocols[protocolName];
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
