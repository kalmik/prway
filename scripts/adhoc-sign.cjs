// Ad-hoc signs the macOS app after packaging. Without a seal over the whole bundle, macOS calls a
// downloaded unsigned app "damaged" and offers no way to open it; with it, users get the "can't verify the
// developer" prompt and can allow it in System Settings → Privacy & Security. Replace with real signing once we have a certificate.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
