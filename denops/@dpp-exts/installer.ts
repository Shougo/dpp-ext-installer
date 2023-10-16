import {
  Actions,
  BaseExt,
  DppOptions,
  Plugin,
  Protocol,
  ProtocolName,
} from "https://deno.land/x/dpp_vim@v0.0.3/types.ts";
import { Denops, vars } from "https://deno.land/x/dpp_vim@v0.0.3/deps.ts";
import { isDirectory } from "https://deno.land/x/dpp_vim@v0.0.3/utils.ts";

type Params = Record<string, never>;

type InstallParams = {
  names: string[];
};

export class Ext extends BaseExt<Params> {
  override actions: Actions<Params> = {
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const plugins = await getPlugins(args.denops, args.actionParams);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        await updatePlugins(args, plugins.filter((_) => bits.shift()));
      },
    },
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        await updatePlugins(
          args,
          await getPlugins(args.denops, args.actionParams),
        );
      },
    },
  };

  override params(): Params {
    return {};
  }
}

async function updatePlugins(args: {
  denops: Denops;
  options: DppOptions;
  protocols: Record<ProtocolName, Protocol>;
  actionParams: unknown;
}, plugins: Plugin[]) {
  if (plugins.length === 0) {
    await args.denops.call(
      "dpp#util#_error",
      "Target plugins are not found.",
    );
    await args.denops.call(
      "dpp#util#_error",
      "You may have used the wrong plugin name," +
        " or all of the plugins are already installed.",
    );
    return;
  }

  // NOTE: Skip local plugins
  for (const plugin of plugins.filter((plugin) => !plugin.local)) {
    await args.denops.call(
      "dpp#ext#installer#_print_progress_message",
      plugin.name,
    );

    const protocol = args.protocols[plugin.protocol ?? ""];

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    // Execute commands
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

      for (
        const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }

      for (
        const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }
    }
  }

  await args.denops.call("dpp#ext#installer#_close_progress_window");

  await args.denops.call("dpp#clear_state");
}

async function getPlugins(
  denops: Denops,
  actionParams: unknown,
): Promise<Plugin[]> {
  const params = actionParams as InstallParams;
  let plugins = Object.values(
    await vars.g.get(
      denops,
      "dpp#_plugins",
    ),
  ) as Plugin[];

  if (params.names.length > 0) {
    plugins = plugins.filter((plugin) =>
      params.names.indexOf(plugin.name) >= 0
    );
  }

  return plugins;
}
