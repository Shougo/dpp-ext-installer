function dpp#ext#installer#_print_message(msg) abort
  const detect_shell = (has('nvim') && nvim_list_uis()->empty())
          \ || (!has('nvim') && mode(v:true) ==# 'ce')

  for mes in s:msg2list(a:msg)
    echomsg '[dpp] ' .. mes
  endfor

  if detect_shell
    " When it is executed from shell, new line is not added in ":echomsg".
    echo ''
  endif
endfunction
function s:msg2list(expr) abort
  return a:expr->type() ==# v:t_list ? a:expr : a:expr->split('\n')
endfunction

function dpp#ext#installer#_print_progress_message(msg) abort
  if !exists('s:progress_winid') || s:progress_winid <= 0
    let s:progress_winid = s:new_progress_window()
  endif

  const bufnr = s:progress_winid->winbufnr()
  if bufnr->getbufline(1) ==# ['']
    call setbufline(bufnr, 1, a:msg)
  else
    call appendbufline(bufnr, '$', a:msg)
  endif
  call win_execute(s:progress_winid, "call cursor('$', 0) | redraw")
endfunction

function dpp#ext#installer#_close_progress_window() abort
  if !exists('s:progress_winid') || s:progress_winid->winbufnr() < 0
    return
  endif

  if has('nvim')
    silent! call nvim_win_close(s:progress_winid, v:true)
  else
    silent! call popup_close(s:progress_winid)
  endif

  let s:progress_winid = -1
endfunction

function s:new_progress_window() abort
  const winrow = 0
  const wincol = &columns / 4
  const winwidth = 80
  const winheight = 20

  if has('nvim')
    const winid = nvim_open_win(nvim_create_buf(v:false, v:true), v:false, #{
          \   border: 'none',
          \   relative: 'editor',
          \   row: winrow,
          \   col: wincol,
          \   focusable: v:false,
          \   noautocmd: v:true,
          \   style: 'minimal',
          \   width: winwidth,
          \   height: winheight,
          \})
  else
    const winid = popup_create([], #{
          \   pos: 'topleft',
          \   line: winrow + 1,
          \   col: wincol + 1,
          \   minwidth: winwidth,
          \   minheight: winheight,
          \   wrap: 0,
          \ })
  endif

  return winid
endfunction

function dpp#ext#installer#_call_hook(hook_name, plugin) abort
  call dpp#source(a:plugin.name)

  const cwd = getcwd()
  try
    call s:cd(a:plugin.path)
    call dpp#util#_call_hook(a:hook_name, a:plugin.name)
  finally
    call s:cd(cwd)
  endtry
endfunction

function! s:cd(path) abort
  if !(a:path->isdirectory())
    return
  endif

  try
    noautocmd execute (haslocaldir() ? 'lcd' : 'cd') a:path->fnameescape()
  catch
    call dpp#util#_error('Error cd to: ' .. a:path)
    call dpp#util#_error('Current directory: ' .. getcwd())
    call dpp#util#_error(v:exception)
    call dpp#util#_error(v:throwpoint)
  endtry
endfunction
