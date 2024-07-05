import {
  Actions,
  BaseExt,
  DppOptions,
  Plugin,
  Protocol,
  ProtocolName,
} from "https://deno.land/x/dpp_vim@v0.2.0/types.ts";
import {
  autocmd,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/dpp_vim@v0.2.0/deps.ts";
import {
  convert2List,
  isDirectory,
  printError,
  safeStat,
} from "https://deno.land/x/dpp_vim@v0.2.0/utils.ts";
import { expandGlob } from "jsr:@std/fs@0.229.1/expand-glob";

type Params = {
  checkDiff: boolean;
  githubAPIToken: string;
  logFilePath: string;
  maxProcesses: number;
};

type InstallParams = {
  names?: string[];
  rollback?: string;
};

type CheckNotUpdatedParams = {
  names?: string[];
  force?: boolean;
};

type UpdatedPlugin = {
  logMessage: string;
  newRev: string;
  oldRev: string;
  plugin: Plugin;
  protocol: Protocol;
};

type Rollbacks = Record<string, string>;

export class Ext extends BaseExt<Params> {
  #updateLogs: string[] = [];
  #logs: string[] = [];

  override async onInit(args: {
    denops: Denops;
  }) {
    await autocmd.group(args.denops, "dpp", (helper: autocmd.GroupHelper) => {
      helper.define(
        "User",
        "dpp:ext:installer:updateDone",
        ":",
      );
    });
  }

  override actions: Actions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          await this.#buildPlugin(args.denops, args.extParams, plugin);
        }
      },
    },
    checkNotUpdated: {
      description: "Check not updated plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as CheckNotUpdatedParams;

        const updatedPlugins = (await this.#checkUpdatedPlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        )).map((plugin) => plugin.name);

        if (updatedPlugins.length === 0) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            "updated plugins are not found.",
          );
          return;
        }

        const force = params.force ?? false;
        if (
          !force && await fn.confirm(
              args.denops,
              `Updated plugins:\n${updatedPlugins.join("\n")}\n\nUpdate now?`,
              "yes\nNo",
              2,
            ) !== 1
        ) {
          return;
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
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          await this.#denoCachePlugin(args.denops, args.extParams, plugin);
        }
      },
    },
    getNotInstalled: {
      description: "Get not installed plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
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
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await this.#checkUpdatedPlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        );

        return plugins;
      },
    },
    getLogs: {
      description: "Get logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
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
        actionParams: unknown;
      }) => {
        return this.#updateLogs;
      },
    },
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
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
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

        await this.#updatePlugins(args, plugins, revisions);
      },
    },
    reinstall: {
      description: "Reinstall plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        if (!params.names || params.names.length === 0) {
          // NOTE: names must be set.
          await printError(
            args.denops,
            "names must be set for reinstall plugins.",
          );
          return;
        }

        const plugins = await getPlugins(args.denops, params.names ?? []);

        const revisions = params.rollback
          ? await loadRollbackFile(args.denops, params.rollback)
          : {};

        for (const plugin of plugins) {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            await Deno.remove(plugin.path, { recursive: true });
          }
        }

        await this.#updatePlugins(args, plugins, revisions);
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
      githubAPIToken: "",
      logFilePath: "",
      maxProcesses: 5,
    };
  }

  async #updatePlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: unknown;
    },
    plugins: Plugin[],
    revisions: Record<string, string>,
  ) {
    this.#logs = [];
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
    const erroredPlugins: Plugin[] = [];
    await limitPromiseConcurrency(
      plugins.map((plugin: Plugin, index: number) => async () => {
        return await this.#updatePlugin(
          args,
          updatedPlugins,
          erroredPlugins,
          revisions,
          plugins.length,
          plugin,
          index + 1,
        );
      }),
      Math.max(args.extParams.maxProcesses, 1),
    );

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
      await this.#printMessage(
        args.denops,
        args.extParams,
        "Updated plugins:\n" +
          `${updatedPlugins.map((updated) => updated.plugin.name).join("\n")}`,
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
              breakingPlugins.map((updated) => updated.plugin.name).join("\n")
            }`,
        );
      }

      await saveRollbackFile(args.denops, args.protocols);
    }

    if (erroredPlugins.length > 0) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        "Error plugins:\n" +
          `${erroredPlugins.map((plugin) => plugin.name).join("\n")}\n` +
          "Please read the error message log with the :message command.",
      );
    }

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    await args.denops.call("dpp#make_state");

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
      actionParams: unknown;
    },
    updatedPlugins: UpdatedPlugin[],
    erroredPlugins: Plugin[],
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

    let commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    if (revisions[plugin.name]) {
      // Add rollback commands
      commands = commands.concat(
        await protocol.protocol.getRollbackCommands({
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
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr, success } = await proc.output();

      for (
        const line of new TextDecoder().decode(stdout).split(/\r?\n/)
          .filter((line) => line.length > 0)
      ) {
        await this.#printProgress(args.denops, args.extParams, line);
      }

      for (
        const line of new TextDecoder().decode(stderr).split(/\r?\n/)
          .filter((line) => line.length > 0)
      ) {
        await this.#printError(args.denops, args.extParams, line);
      }

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

        await this.#denoCachePlugin(args.denops, args.extParams, plugin);

        updatedPlugins.push({
          logMessage,
          oldRev,
          newRev,
          plugin,
          protocol,
        });
      }
    } else {
      erroredPlugins.push(plugin);
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
    const queries = [];
    for (const [index, plugin] of plugins.entries()) {
      if (!plugin.repo) {
        continue;
      }
      const pluginNames = plugin.repo.split(/\//);
      if (pluginNames.length !== 2) {
        // Invalid repository name
        continue;
      }

      // NOTE: "repository" API is faster than "search" API
      queries.push(
        `repo${index}: repository(owner:"${
          pluginNames.slice(-2, -1)
        }", name: "${pluginNames.slice(-1)}"){ pushedAt }`,
      );
    }

    // POST github API
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${args.extParams.githubAPIToken}`,
      },
      body: JSON.stringify({
        query: `
          query {
            ${queries.join("\n")}
          }
        `,
      }),
    });

    const respJson = (await resp.json()).data;
    //console.log(baseUpdated);

    return plugins.filter((_, index) =>
      respJson[`repo${index}`]?.pushedAt &&
      new Date(respJson[`repo${index}`].pushedAt) > baseUpdated
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

    let logMessage = "";
    for (const command of commands) {
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr } = await proc.output();

      logMessage += new TextDecoder().decode(stdout);

      for (const line of new TextDecoder().decode(stderr).split(/\r?\n/)) {
        await this.#printError(denops, extParams, line);
      }
    }

    return logMessage;
  }

  async #buildPlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
  ) {
    if (!plugin.path || !await isDirectory(plugin.path) || !plugin.build) {
      return;
    }

    const proc = new Deno.Command(
      await op.shell.getGlobal(denops),
      {
        args: [await op.shellcmdflag.getGlobal(denops), plugin.build],
        cwd: plugin.path,
        stdout: "piped",
        stderr: "piped",
      },
    );

    const { stdout, stderr } = await proc.output();

    for (
      const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
        line,
      ) => line.length > 0)
    ) {
      await this.#printProgress(denops, extParams, line);
    }

    for (
      const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
        line,
      ) => line.length > 0)
    ) {
      await this.#printError(denops, extParams, line);
    }
  }

  async #denoCachePlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
  ) {
    if (
      !plugin.path || !await isDirectory(`${plugin.path}/denops`) ||
      !await fn.executable(denops, "deno")
    ) {
      return;
    }

    const files = [];
    for await (const file of expandGlob(`${plugin.path}/denops/**/*.ts`)) {
      files.push(file.path);
    }

    // Execute "deno cache" to optimize
    const proc = new Deno.Command(
      "deno",
      {
        args: ["cache", "--no-check", "--reload"].concat(files),
        cwd: plugin.path,
        stdout: "piped",
        stderr: "piped",
      },
    );

    const { stdout, stderr } = await proc.output();

    for (
      const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
        line,
      ) => line.length > 0)
    ) {
      await this.#printProgress(denops, extParams, line);
    }

    for (
      const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
        line,
      ) => line.length > 0)
    ) {
      await this.#printError(denops, extParams, line);
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
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr } = await proc.output();

      for (const line of new TextDecoder().decode(stdout).split(/\r?\n/)) {
        await this.#printProgress(denops, extParams, line);
      }

      for (const line of new TextDecoder().decode(stderr).split(/\r?\n/)) {
        await this.#printError(denops, extParams, line);
      }
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
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr } = await proc.output();

      for (const line of new TextDecoder().decode(stdout).split(/\r?\n/)) {
        await outputCheckDiff(denops, line);
      }

      for (const line of new TextDecoder().decode(stderr).split(/\r?\n/)) {
        await this.#printError(denops, extParams, line);
      }
    }
  }

  async #printError(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
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
  ) as Plugin[]).filter((plugin) => !plugin.local && !plugin.frozen);

  if (names.length > 0) {
    plugins = plugins.filter((plugin) => names.indexOf(plugin.name) >= 0);
  }

  return plugins;
}

async function outputCheckDiff(denops: Denops, line: string) {
  if (line.length === 0) {
    return;
  }

  const bufname = "dpp-diff";
  const bufnr = await fn.bufexists(denops, bufname)
    ? await fn.bufnr(denops, bufname)
    : await fn.bufadd(denops, bufname);

  if (
    await fn.bufwinnr(denops, bufnr) < 0 && await fn.bufexists(denops, bufnr)
  ) {
    const cmd = await fn.escape(
      denops,
      "setlocal bufhidden=wipe filetype=diff buftype=nofile nolist | syntax enable",
      " ",
    );
    await denops.cmd(`sbuffer +${cmd} ${bufnr}`);
  }

  await fn.appendbufline(denops, bufnr, "$", line);
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

async function limitPromiseConcurrency<T>(
  funcs: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  const execFunc = async (): Promise<void> => {
    if (i === funcs.length) return;
    const func = funcs[i++];
    results.push(await func());
    return execFunc();
  };

  const initialFuncs = funcs.slice(0, limit).map(() => execFunc());
  await Promise.all(initialFuncs);

  return results;
}
