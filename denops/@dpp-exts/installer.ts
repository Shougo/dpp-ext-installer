import {
  Actions,
  BaseExt,
  DppOptions,
  Plugin,
  Protocol,
  ProtocolName,
} from "https://deno.land/x/dpp_vim@v0.0.7/types.ts";
import {
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/dpp_vim@v0.0.7/deps.ts";
import {
  convert2List,
  isDirectory,
  safeStat,
} from "https://deno.land/x/dpp_vim@v0.0.7/utils.ts";

type Params = {
  checkDiff: boolean;
  maxProcesses: number;
};

type InstallParams = {
  names: string[];
  rollback: string;
};

type UpdatedPlugin = {
  logMessage: string;
  newRev: string;
  oldRev: string;
  plugin: Plugin;
  protocol: Protocol;
};

export class Ext extends BaseExt<Params> {
  private updateLogs: string[] = [];
  private logs: string[] = [];

  override actions: Actions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          await this.buildPlugin(args.denops, plugin);
        }
      },
    },
    check_install: {
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
    getLogs: {
      description: "Get logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        return this.logs;
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
        return this.updateLogs;
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

        await this.updatePlugins(
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

        await this.updatePlugins(args, plugins, revisions);
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
          await args.denops.call(
            "dpp#util#_error",
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

        await this.updatePlugins(args, plugins, revisions);
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
      maxProcesses: 5,
    };
  }

  private async updatePlugins(
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
    this.logs = [];
    this.updateLogs = [];

    if (plugins.length === 0) {
      await this.printError(
        args.denops,
        "Target plugins are not found.",
      );
      await this.printError(
        args.denops,
        "You may have used the wrong plugin name," +
          " or all of the plugins are already installed.",
      );
      return;
    }

    const updatedPlugins: UpdatedPlugin[] = [];
    const erroredPlugins: Plugin[] = [];
    await limitPromiseConcurrency(
      plugins.map((plugin: Plugin, index: number) => async () => {
        return await this.updatePlugin(
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
        await this.checkDiff(
          args.denops,
          updated.plugin,
          updated.protocol,
          updated.oldRev,
          updated.newRev,
        );
      }
    }

    if (updatedPlugins.length > 0) {
      await this.printMessage(
        args.denops,
        "Updated plugins:\n" +
          `${updatedPlugins.map((updated) => updated.plugin.name).join("\n")}`,
      );

      // If it has breaking changes commit message
      // https://www.conventionalcommits.org/en/v1.0.0/
      const breakingPlugins = updatedPlugins.filter(
        (updated) => updated.logMessage.match(/.*!.*:|BREAKING CHANGE:/),
      );

      if (breakingPlugins.length > 0) {
        await this.printMessage(
          args.denops,
          "Breaking updated plugins:\n" +
            `${
              breakingPlugins.map((updated) => updated.plugin.name).join("\n")
            }`,
        );
      }

      await saveRollbackFile(args.denops, args.protocols);
    }

    if (erroredPlugins.length > 0) {
      await this.printMessage(
        args.denops,
        "Error plugins:\n" +
          `${erroredPlugins.map((plugin) => plugin.name).join("\n")}` +
          "Please read the error message log with the :message command.\n",
      );
    }

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    await args.denops.call("dpp#clear_state");
  }

  async updatePlugin(
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
    await this.printProgress(
      args.denops,
      `[${index}/${maxLength}] ${plugin.name}`,
    );

    const protocol = args.protocols[plugin.protocol ?? ""];

    const oldRev = await protocol.protocol.getRevision({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

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
        await this.printProgress(args.denops, line);
      }

      for (
        const line of new TextDecoder().decode(stderr).split(/\r?\n/)
          .filter((line) => line.length > 0)
      ) {
        await this.printError(args.denops, line);
      }

      if (!success) {
        updateSuccess = false;
        break;
      }
    }

    if (updateSuccess) {
      // Execute "post_update" before "build"
      if (plugin.hook_post_update) {
        await args.denops.call(
          "dpp#ext#installer#_call_hook",
          "post_update",
          plugin,
        );
      }

      await this.buildPlugin(args.denops, plugin);

      const newRev = await protocol.protocol.getRevision({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      const logMessage = await this.getLogMessage(
        args.denops,
        plugin,
        protocol,
        newRev,
        oldRev,
      );

      if (oldRev.length === 0 || oldRev !== newRev) {
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

  async getLogMessage(
    denops: Denops,
    plugin: Plugin,
    protocol: Protocol,
    newRev: string,
    oldRev: string,
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
        await this.printError(denops, line);
      }
    }

    return logMessage;
  }

  async buildPlugin(
    denops: Denops,
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
      await this.printProgress(denops, line);
    }

    for (
      const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
        line,
      ) => line.length > 0)
    ) {
      await this.printError(denops, line);
    }
  }

  async checkDiff(
    denops: Denops,
    plugin: Plugin,
    protocol: Protocol,
    newRev: string,
    oldRev: string,
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
        await this.printError(denops, line);
      }
    }
  }

  private async printError(denops: Denops, msg: string) {
    await denops.call("dpp#util#_error", msg);
    this.updateLogs.push(msg);
    this.logs.push(msg);
  }

  private async printMessage(denops: Denops, msg: string) {
    await denops.call("dpp#ext#installer#_print_message", msg);
    this.updateLogs.push(msg);
    this.logs.push(msg);
  }

  private async printProgress(denops: Denops, msg: string) {
    await denops.call("dpp#ext#installer#_print_progress_message", msg);
    this.logs.push(msg);
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

  const bufname = "dein-diff";
  const bufnr = await fn.bufexists(denops, bufname)
    ? await fn.bufnr(denops, bufname)
    : await fn.bufadd(denops, bufname);

  if (await fn.bufwinnr(denops, bufnr) < 0) {
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
  const revisions: Record<string, string> = {};
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

  return JSON.parse(await Deno.readTextFile(rollbackFile)) as Record<
    string,
    string
  >;
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
