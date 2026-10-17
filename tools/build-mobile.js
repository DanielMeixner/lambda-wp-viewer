const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const iosVersion = version.split('-')[0];
const gradle = path.join(root, 'mobile', 'android', 'app', 'build.gradle');
fs.writeFileSync(gradle, fs.readFileSync(gradle, 'utf8')
  .replace(/versionName "[^"]+"/, `versionName "${version}"`));
const xcodeProject = path.join(root, 'mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
fs.writeFileSync(xcodeProject, fs.readFileSync(xcodeProject, 'utf8')
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${iosVersion};`));
const output = path.join(root, 'mobile', 'www');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(root, 'src', 'mobile'), output, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'registers.js'), path.join(output, 'registers.js'));
fs.copyFileSync(path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'),
  path.join(output, 'capacitor.js'));
fs.copyFileSync(path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
  path.join(output, 'chart.umd.js'));
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(output, 'assets', 'icon.png'));
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(output, 'icon.png'));
console.log('Mobile web assets copied to mobile/www');
