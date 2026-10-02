/*
 * electron-builder 配置：产出 Windows x64 的 NSIS 安装包与便携版 exe。
 */
module.exports = {
  appId: 'com.yunx.desktop',
  productName: '云析 YunX',
  copyright: 'Copyright © 2026 YunX Desktop Port (AGPL-3.0)',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: ['dist/**/*', 'package.json', '!**/*.map'],
  // 不打包源码与 repo 克隆
  extraMetadata: {
    main: 'dist/main/main.js',
  },
  // 不做代码签名：本机无证书，且 electron-builder 会尝试联网下载 signtool 而失败
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    // 产物文件名必须全 ASCII：GitHub Release 会剥掉附件名里的非 ASCII 字符，
    // 用 ${productName}（含中文）会导致「便携版」被吃掉，两个附件名无法区分。
    artifactName: 'YunX-Desktop-${version}-${arch}-Setup.${ext}',
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '云析 YunX',
    deleteAppDataOnUninstall: false,
  },
  portable: {
    // 与安装包区分开（同样保持全 ASCII）
    artifactName: 'YunX-Desktop-${version}-${arch}-Portable.${ext}',
  },
};
