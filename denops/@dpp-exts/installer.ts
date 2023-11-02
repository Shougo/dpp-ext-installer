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
} from "https://deno.land/x/dpp_vim@v0.0.7/utils.ts";

type Params = {
  checkDiff: boolean;
  maxProcesses: number;
};

type InstallParams = {
  names: string[];
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
    getLog: {
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
    getUpdatesLog: {
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

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        await this.updatePlugins(args, plugins.filter((_) => bits.shift()));
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
        await this.updatePlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
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

        for (const plugin of plugins) {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            await Deno.remove(plugin.path, { recursive: true });
          }
        }

        await this.updatePlugins(args, plugins);
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
      maxProcesses: 5,
    };
  }

  private async updatePlugins(args: {
    denops: Denops;
    options: DppOptions;
    protocols: Record<ProtocolName, Protocol>;
    extParams: Params;
    actionParams: unknown;
  }, plugins: Plugin[]) {
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
        (updated) =>
        updated.logMessage.match(/.*!.*:|BREAKING CHANGE:/)
      );

      if (breakingPlugins.length > 0) {
        await this.printMessage(
          args.denops,
          "Breaking updated plugins:\n" +
            `${breakingPlugins.map((updated) => updated.plugin.name).join("\n")}`,
        );
      }
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

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

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
  ) as Plugin[]).filter((plugin) => !plugin.local);

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
