# dpp-ext-installer

This ext implements installer.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### dpp.vim

https://github.com/Shougo/dpp.vim

## Configuration

```vim
	" Install plugins
	call dpp#async_ext_action('installer', 'install')

	" Update plugins
	call dpp#async_ext_action('installer', 'update')

	" Update dein.vim
	call dpp#async_ext_action('installer', 'update',
	\ #{ names: ['dein.vim'] })

	" Check not updated plugins
	call dpp#async_ext_action('installer', 'checkNotUpdated')

	" Get not installed plugins
	echo dpp#ext_action('installer', 'getNotInstalled')
```

## Screenshots

![install UI](install_ui.png)
