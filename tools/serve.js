'use strict';

// Run the panel without the game: boots the module against a stub toolbox and
// starts the Tauri overlay on top of it. Ctrl+C to stop.
// Run: node tools/serve.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.QA_TAURI_PORT, 10) || 7331;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

const items = new Map([
	[283999, { name: 'Thread Passive Item' }],
	[100001, { name: 'Ancient Stone Axe' }],
	[100002, { name: 'Moonshade Brooch' }],
	[220175, { name: 'Fallen Schism' }],
	[283998, { name: 'Ancient Relic' }],
]);

const mod = {
	log: m => console.log('[mod]', m),
	hook: () => {},
	send: (name, ver, obj) => { if (obj && obj.command) console.log('[mod] sent:', obj.command); },
	command: { add: name => console.log('[mod] chat command /8', name) },
	require: {
		'tera-game-state': {
			me: { gameId: 1, name: 'Tester', level: 80, zone: 123, inDungeon: false },
			data: { items }
		}
	},
	queryData: () => Promise.resolve([]),
	clientInterface: { once: () => {} },
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: id => clearTimeout(id)
};

new (require(path.join(ROOT, 'index.js')))(mod);

const exe = [
	process.env.QA_TAURI_EXE,
	path.join(ROOT, 'qa-tauri.exe'),
	path.join(ROOT, 'tauri', 'src-tauri', 'target', 'release', 'qa-tauri.exe')
].find(p => p && fs.existsSync(p));

if (exe) {
	spawn(exe, ['--url', BASE + '/'], { detached: true, stdio: 'ignore' }).unref();
	console.log('overlay started:', exe);
} else {
	console.log('overlay not built - open', BASE, 'in a browser instead');
}
console.log('panel on', BASE, '- ctrl+c to stop');
