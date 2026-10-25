# 发布新版本

版本号只在 `package.json` 中维护。安装包文件名、安装程序显示的版本、应用内「关于与更新」都读取这个值；GitHub 标签必须是 `v<版本号>`，例如 `v0.2.1`。

## 步骤

1. 修改 `package.json` 的 `version`（例如 `0.2.1`），并运行 `npm install --package-lock-only` 同步 `package-lock.json`。
2. 编写更新说明 `release-notes/v0.2.1.md`（可选；没有时自动根据提交生成）。应用内「检查更新」会显示这份说明的前几行。
3. 本地检查：

   ```bash
   node scripts/check-version.mjs v0.2.1
   npm run typecheck
   npm test
   npm run e2e
   ```

4. 提交并推送到 main，然后创建并推送标签：

   ```bash
   git tag v0.2.1
   git push origin v0.2.1
   ```

5. GitHub Actions（`.github/workflows/release.yml`）会在 Windows 上测试、打包，并创建 Release `v0.2.1`，附带 `ComfyEngi-0.2.1-setup.exe`。同名 Release 已存在时工作流失败，不会覆盖。

预发布版使用 `v0.3.0-beta.1` 这样的标签，会创建为预发布 Release；应用内检查更新只比较最新正式版。

## 手动打包（不使用 GitHub Actions）

在 Windows 上：

```bash
npm ci
npm run dist:installer
```

安装包生成在 `dist/ComfyEngi-<版本号>-setup.exe`，可在 GitHub 网页上手动创建 Release `v<版本号>` 并上传。

## 数据兼容

- 安装程序只替换安装目录（默认 `%LOCALAPPDATA%\Programs\ComfyEngi`）。用户数据在 `%APPDATA%\ComfyEngi`（最近工作区记录）和用户选择的工作区（Vault）中，安装、升级、卸载都不会修改或删除。应用不允许把工作区或输出目录选在安装目录内。
- 需要升级数据库结构时，沿用现有机制：打开旧库前先在工作区 `data/backups/` 中备份，再执行迁移。新增设置项使用默认值，旧 Vault 可直接打开。
- 发布前用 `npm test`（含旧库迁移测试）和 `npm run e2e` 确认旧数据可读取。

## 代码签名

目前安装包未签名，Windows SmartScreen 可能提示「Windows 已保护你的电脑」，需要点击「更多信息 → 仍要运行」。如需消除提示，需要购买代码签名证书，并在 GitHub Actions 中配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（electron-builder 会自动签名）。
