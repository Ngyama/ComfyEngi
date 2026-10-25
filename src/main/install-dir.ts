// 安装目录保护：安装新版或卸载时，NSIS 会整体替换 / 删除安装目录，用户数据不能放在其中。

import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { app } from 'electron'

/** 打包后的安装目录；开发环境返回 null */
export function installDir(): string | null {
  return app.isPackaged ? dirname(app.getPath('exe')) : null
}

/** p 是否位于安装目录内（含安装目录本身） */
export function insideInstallDir(p: string): boolean {
  const dir = installDir()
  if (!dir) return false
  const rel = relative(resolve(dir).toLowerCase(), resolve(p).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const INSTALL_DIR_ERROR = '不能选择程序安装目录（或其子目录）：安装新版本或卸载时该目录会被替换或删除。请选择其他位置，例如「文档」下的文件夹。'
