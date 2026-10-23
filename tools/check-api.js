'use strict';

// Boots the mod against a stub toolbox and exercises the panel API over HTTP.
// Run: node tools/check-api.js
// The same server serves the Tauri overlay, so this is the panel's smoke test.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.QA_TAURI_PORT, 10) || 7331;
const BASE = `http://127.0.0.1:${PORT}`;
const OVERLAY = path.join(__dirname, '..', 'tauri', 'src-tauri', 'target', 'release', 'qa-tauri.exe');

// Record what the panel asked for, so we can prove the overlay really loads it.
const requests = [];
const createServer = http.createServer;
http.createServer = function (handler) {
	return createServer(function (req, res) {
		requests.push(req.url.split('?')[0]);
		handler(req, res);
	});
};

const chats = [];
const hooks = {};
const items = new Map([
	[283999, { name: 'Thread Passive Item' }],
	[100001, { name: 'Ancient Stone Axe' }],
	[100002, { name: 'Moonshade Brooch' }],
]);

const mod = {
	log: m => console.log('[mod]', m),
	hook: (name, version, cb) => { hooks[name + ':' + version] = cb; },
	send: () => {},
	command: {
		add: name => console.log('[mod] chat command /8', name),
		message: (mod, msg) => chats.push(msg)
	},
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

// The toolbox loads a mod with `new`, so the module gets a destructor.
const modExport = require(path.join(__dirname, '..', 'index.js'));
let instance = new modExport(mod);

function get(url) {
	return new Promise((resolve, reject) => {
		http.get(url, res => {
			let body = '';
			res.on('data', d => (body += d));
			res.on('end', () => resolve({ status: res.statusCode, body }));
		}).on('error', reject);
	});
}

let failed = 0;
function check(name, cond, extra) {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failed++;
		console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`);
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	// The server binds asynchronously; give it a moment.
	await sleep(300);

	const page = await get(BASE + '/');
	check('GET / serves the panel', page.status === 200 && page.body.includes('QA Menu'), `status ${page.status}`);

	const commands = await get(BASE + '/commands');
	let cfg = null;
	try { cfg = JSON.parse(commands.body); } catch (e) { /* reported below */ }
	check('GET /commands returns the menu layout', !!(cfg && Array.isArray(cfg.sections)));

	const state = await get(BASE + '/state');
	let st = null;
	try { st = JSON.parse(state.body); } catch (e) { /* reported below */ }
	check('GET /state returns game state', !!(st && st.inGame === true && st.char === 'Tester'), state.body.slice(0, 80));

	const run = await get(BASE + '/run?cmd=speed%201');
	let r = null;
	try { r = JSON.parse(run.body); } catch (e) { /* reported below */ }
	check('GET /run sends the command', !!(r && r.ok === true && r.sent === 'speed 1'), run.body.slice(0, 80));

	const missing = await get(BASE + '/nope');
	check('unknown route is 404', missing.status === 404, `status ${missing.status}`);

	// --- item id logger ------------------------------------------------------
	const tooltip = hooks['C_SHOW_ITEM_TOOLTIP_EX:2'] || hooks['C_SHOW_ITEM_TOOLTIP_EX:3'];
	check('the tooltip hook is registered', !!tooltip, Object.keys(hooks).join(', '));

	if (tooltip) {
		tooltip({ type: 17, id: 19699 });                 // 17 = persistent, not a hover
		let log = JSON.parse((await get(BASE + '/items/log')).body);
		check('only hover tooltips are logged', log.items.length === 0, JSON.stringify(log.items));

		tooltip({ type: 20, id: 19699 });                 // 20 = hover
		tooltip({ type: 20, id: 19699 });                 // same item again
		log = JSON.parse((await get(BASE + '/items/log')).body);
		check('a hovered item is logged once', log.items.length === 1, JSON.stringify(log.items));
		check('the name is resolved', log.items[0] && log.items[0].name === 'Simple Grounding Brooch', JSON.stringify(log.items[0]));

		await get(BASE + '/items/log/option?key=chat&value=1');
		chats.length = 0;
		tooltip({ type: 20, id: 100001 });
		check('the chat option logs to chat', chats.length === 1 && /100001/.test(chats[0]), chats.join(' | '));
		await get(BASE + '/items/log/option?key=chat&value=0');
	}

	// The overlay: does it open the panel and pull its data?
	if (fs.existsSync(OVERLAY)) {
		requests.length = 0;
		const child = spawn(OVERLAY, ['--url', BASE + '/'], { stdio: 'ignore' });
		await sleep(6000);
		check('overlay loads the panel page', requests.includes('/'), 'requested: ' + requests.join(' '));
		check('overlay pulls the menu data', requests.includes('/commands'), 'requested: ' + requests.join(' '));
		spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
	} else {
		console.log('  skip overlay checks - build it first: cd tauri/src-tauri && cargo build --release');
	}

	// Reload: the old server has to release the port for the new instance.
	instance.destructor();
	await sleep(300);
	instance = new modExport(mod);
	await sleep(300);
	const afterReload = await get(BASE + '/');
	check('module reload releases the port', afterReload.status === 200, `status ${afterReload.status}`);

	console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
	process.exit(failed ? 1 : 0);
})().catch(e => {
	console.error('check-api failed:', e.message);
	process.exit(1);
});
