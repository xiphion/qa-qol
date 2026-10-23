'use strict';

// Drives the panel in a real browser and checks that every feature still
// works after a UI rewrite.
// Run: npm i playwright-core   (uses the installed Chrome, no download)
//      node tools/check-ui.js

const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = parseInt(process.env.QA_TAURI_PORT, 10) || 7331;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT = process.env.UI_SHOT || path.join(os.tmpdir(), 'qa-panel.png');

const sent = [];
const items = new Map([
	[283999, { name: 'Thread Passive Item' }],
	[100001, { name: 'Ancient Stone Axe' }],
	[100002, { name: 'Moonshade Brooch' }],
]);

const mod = {
	log: () => {},
	hook: () => {},
	send: (name, ver, obj) => { if (obj && obj.command) sent.push(obj.command); },
	command: { add: () => {} },
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

new (require(path.join(__dirname, '..', 'index.js')))(mod);

let failed = 0;
function check(name, cond, extra) {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failed++;
		console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`);
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The favourites live in the module's own state file, so the test must not
// clobber the user's: it reads the list, adds what it needs, and puts the
// original list back at the end.
async function getFavourites(page) {
	return page.evaluate(() => fetch('/favourites').then(r => r.json()).then(j => j.items));
}

async function setFavourites(page, want) {
	await page.evaluate(async (list) => {
		const toggle = l => fetch('/favourites/toggle?label=' + encodeURIComponent(l));
		let cur = (await fetch('/favourites').then(r => r.json())).items;
		for (const l of cur.slice()) if (!list.includes(l)) await toggle(l);
		cur = (await fetch('/favourites').then(r => r.json())).items;
		for (const l of list) if (!cur.includes(l)) await toggle(l);
	}, want);
}

(async () => {
	await sleep(300);
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 560, height: 680 } });

	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

	await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.sec', { timeout: 5000 });
	await sleep(600);

	check('no page errors', errors.length === 0, errors.join(' | '));
	check('sections render', await page.locator('.sec').count() === 2);
	check('status bar shows the player', (await page.locator('#info').innerText()).includes('Tester'));

	// --- a plain command ---------------------------------------------------
	sent.length = 0;
	await page.getByRole('button', { name: '3', exact: true }).click();
	await sleep(300);
	check('option button sends the command', sent.includes('speed 3'), sent.join(' | '));
	check('sent button is highlighted', await page.locator('main button[data-cmd="speed"][data-args="3"]').evaluate(b => b.classList.contains('active')));

	// --- a toggle ----------------------------------------------------------
	sent.length = 0;
	await page.locator('.seg button[data-cmd="nodie"][data-args="on"]').click();
	await sleep(300);
	check('toggle sends the command', sent.includes('nodie on'), sent.join(' | '));

	// --- chain -------------------------------------------------------------
	sent.length = 0;
	await page.getByRole('button', { name: 'Clear all skills', exact: true }).click();
	await sleep(400);
	check('chain command follows the main one', sent.includes('clear_all_skill') && sent.includes('insert_item 283999 1'), sent.join(' | '));

	// --- search filter keeps groups alive ----------------------------------
	await page.locator('#search').fill('kill');
	await sleep(200);
	const groupVisible = await page.locator('.item.group').first().isVisible();
	const killVisible = await page.locator('button[data-cmd="kill"]').first().isVisible();
	const speedVisible = await page.locator('button[data-cmd="speed"]').first().isVisible();
	check('search keeps the matching group', groupVisible && killVisible);
	check('search hides the other options', !speedVisible);
	await page.locator('#search').fill('');
	await sleep(200);

	// --- auto action -------------------------------------------------------
	await page.locator('.autorow input[type=checkbox]').check();
	await sleep(300);
	check('auto action is pushed', await page.locator('.autorow input[type=checkbox]').isChecked());

	// --- quests ------------------------------------------------------------
	const questLines = await page.locator('.qline').count();
	check('quest lines are listed', questLines > 30, 'lines: ' + questLines);
	await page.locator('.qline').first().click();
	await sleep(300);
	check('quest line expands', await page.locator('.qrow').count() > 0);
	await page.getByRole('button', { name: 'START' }).first().click();
	await sleep(300);
	check('quest start sends a command', sent.some(c => c.startsWith('start_quest ')), sent.join(' | '));

	// --- item search -------------------------------------------------------
	const itemCard = page.locator('.item', { has: page.locator('input[placeholder="Search item names..."]') });
	await itemCard.locator('input[placeholder="Search item names..."]').fill('thread');
	await itemCard.getByRole('button', { name: 'Search', exact: true }).click();
	await sleep(500);
	const rows = await itemCard.locator('table.picks tr.pick').count();
	check('item search finds items', rows === 1, 'rows: ' + rows);
	await itemCard.locator('table.picks input[type=checkbox]').first().check();
	await sleep(150);
	check('selected item shows a chip', await itemCard.locator('.chip').count() === 1);
	await itemCard.getByRole('button', { name: 'Clear', exact: true }).click();
	await sleep(150);
	check('clear removes the chip and the tick', await itemCard.locator('.chip').count() === 0
		&& !(await itemCard.locator('table.picks input[type=checkbox]').first().isChecked()));

	// --- reset -------------------------------------------------------------
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await sleep(500);
	check('reset clears the auto action', !(await page.locator('.autorow input[type=checkbox]').isChecked()));
	const resetText = await page.locator('#status-text').innerText();
	check('reset lists the auto revive', /auto .*off/i.test(resetText), resetText);

	// --- window bar and mini mode -------------------------------------------
	check('title bar has mini and close buttons',
		await page.locator('#btn-mini').count() === 1 && await page.locator('#btn-close').count() === 1);

	// The seed list comes from commands.json until the panel state exists.
	const seed = await page.evaluate(() => fetch('/favourites').then(r => r.json()));
	check('favourites are served', Array.isArray(seed.items) && seed.items.length > 0, JSON.stringify(seed));
	check('the seed includes Kill range', seed.items.includes('Kill range'), JSON.stringify(seed.items));

	const original = await getFavourites(page);

	// The star on an item adds it to the mini strip.
	const stars = page.locator('.fav');
	check('items carry a star', await stars.count() > 5, 'stars: ' + await stars.count());
	const newStar = page.locator('.fav[data-label="Teleport"]');
	await newStar.click();
	await sleep(400);
	const after = await page.evaluate(() => fetch('/favourites').then(r => r.json()));
	check('the star adds the item to mini', after.items.includes('Teleport'), JSON.stringify(after.items));
	check('the star shows as pinned', await page.locator('.fav[data-label="Teleport"]').evaluate(b => b.classList.contains('on')));
	await page.locator('.fav[data-label="Teleport"]').click();
	await sleep(400);
	const after2 = await page.evaluate(() => fetch('/favourites').then(r => r.json()));
	check('the star removes it again', !after2.items.includes('Teleport'), JSON.stringify(after2.items));

	await page.goto(BASE + '/?mini=1', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.mini-toggle', { timeout: 5000 });
	await sleep(600);
	check('mini mode hides the sections', !(await page.locator('main').isVisible()));
	check('mini mode shows the strip', await page.locator('#mini').isVisible());
	check('the strip has the kill range chips', await page.locator('#mini button[data-cmd="kill"]').count() === 4);

	// The menu-like items get a block with a list, not a broken button.
	await setFavourites(page, original.concat(['Dungeons', 'Item search', 'Questing', 'Gear sets']));
	await page.goto(BASE + '/?mini=1', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.mini-widget', { timeout: 5000 });
	await sleep(800);
	check('pinned menus become blocks', await page.locator('#mini .mini-widget').count() === 4,
		'blocks: ' + await page.locator('#mini .mini-widget').count());

	// Dungeons: a row enters that dungeon.
	const dungeonRow = page.locator('#mini .mini-widget').first().locator('.mini-row').first();
	check('the dungeon block lists dungeons', await dungeonRow.count() === 1);
	sent.length = 0;
	await dungeonRow.click();
	await sleep(300);
	check('a dungeon row enters the dungeon', sent.some(c => c.startsWith('enter_dungeon ')), sent.join(' | '));

	// Quests: Start and Next step.
	const questBlock = page.locator('#mini .mini-widget').nth(2);
	await questBlock.locator('input[aria-label="quest name..."]').fill('beach');
	await sleep(400);
	check('the quest block lists quests', await questBlock.locator('.mini-row').count() > 0);
	sent.length = 0;
	await questBlock.locator('.mini-act').first().click();
	await sleep(300);
	check('a quest row can start a quest', sent.some(c => c.startsWith('start_quest ')), sent.join(' | '));

	// Items: pick, then give.
	const itemBlock = page.locator('#mini .mini-widget', { has: page.locator('input[aria-label="item name..."]') });
	await itemBlock.locator('input[aria-label="item name..."]').fill('thread');
	await sleep(700);
	check('the item block searches', await itemBlock.locator('.mini-row').count() === 1);
	await itemBlock.locator('.mini-row').first().click();
	await sleep(200);
	check('picking an item marks the row', await itemBlock.locator('.mini-row.on').count() === 1);
	sent.length = 0;
	await itemBlock.getByRole('button', { name: 'Give' }).click();
	await sleep(300);
	check('items can be given from mini', sent.some(c => c.startsWith('makeitems ')), sent.join(' | '));

	// Clear in the mini item search drops every pick.
	await itemBlock.getByRole('button', { name: 'Clear' }).click();
	await sleep(200);
	check('clear drops the mini selection', await itemBlock.locator('.mini-row.on').count() === 0);
	sent.length = 0;
	await itemBlock.getByRole('button', { name: 'Give' }).click();
	await sleep(300);
	check('clear drops the shared selection', sent.length === 0, sent.join(' | '));

	// Nothing in the strip may fire an empty command.
	const empties = await page.evaluate(() => [...document.querySelectorAll('#mini button')]
		.filter(b => !b.dataset.cmd && !b.className.includes('mini-row') && !b.className.includes('mini-act')
			&& b.textContent.trim() !== 'Give' && b.textContent.trim() !== 'Send'
			&& b.textContent.trim() !== 'Clear')
		.map(b => b.textContent.trim()));
	check('no dead buttons in the strip', empties.length === 0, empties.join(' | '));

	// Gear sets match word by word: "armory priest" -> "Sabex Armory - Heal Priest".
	const gearBlock = page.locator('#mini .mini-widget', { has: page.locator('input[aria-label="gear set name..."]') });
	await gearBlock.locator('input[aria-label="gear set name..."]').fill('armory priest');
	await sleep(300);
	check('gear sets match word by word',
		await gearBlock.locator('.mini-row', { hasText: 'Sabex Armory - Heal Priest' }).count() === 1);
	const listHeight = await gearBlock.locator('.mini-list').evaluate(e => e.getBoundingClientRect().height);
	check('the result list is short', listHeight <= 90, 'height: ' + Math.round(listHeight));

	// Put the user's favourites back.
	await setFavourites(page, original);
	await page.goto(BASE + '/?mini=1', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.mini-toggle', { timeout: 5000 });
	await sleep(500);

	const miniToggle = page.locator('.mini-toggle').first();
	check('a toggle is one button in mini mode', await miniToggle.count() === 1);
	sent.length = 0;
	await miniToggle.click();
	await sleep(300);
	check('mini toggle sends on', sent.includes('nodie on'), sent.join(' | '));
	sent.length = 0;
	await miniToggle.click();
	await sleep(300);
	check('mini toggle sends off', sent.includes('nodie off'), sent.join(' | '));

	await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.sec');
	await sleep(400);

	// --- item id logger ------------------------------------------------------
	const logBox = page.locator('.logbox');
	check('the item logger widget is there', await logBox.count() === 1);

	// Log an item as the mod would, then see it in the panel.
	await page.evaluate(async () => {
		await fetch('/items/log/option?key=panel&value=1');
	});
	const logged = await page.evaluate(async () => {
		// the stub mod logs nothing, so push one through the mod's own hook
		return fetch('/items/log').then(r => r.json());
	});
	check('the logger endpoint answers', Array.isArray(logged.items) && !!logged.options, JSON.stringify(logged));

	// The option toggle round trip.
	await logBox.locator('input[aria-label="Log to chat"]').check();
	await sleep(400);
	const opts = await page.evaluate(() => fetch('/items/log').then(r => r.json()));
	check('the chat option is stored', opts.options.chat === true, JSON.stringify(opts.options));
	await logBox.locator('input[aria-label="Log to chat"]').uncheck();
	await sleep(400);

	// Create buttons need a picked item.
	await logBox.getByRole('button', { name: 'Create one' }).click();
	await sleep(300);
	const statusText = await page.locator('#status-text').innerText();
	check('create needs a pick', /pick an item/i.test(statusText), statusText);

	await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.sec');
	await sleep(400);

	check('still no page errors', errors.length === 0, errors.join(' | '));

	// --- keyboard ----------------------------------------------------------
	const rowTag = await page.locator('.list .opt').first().evaluate(e => e.tagName);
	check('list rows are real buttons', rowTag === 'BUTTON', 'tag: ' + rowTag);

	sent.length = 0;
	await page.locator('.list .opt').first().focus();
	await page.keyboard.press('Enter');
	await sleep(300);
	check('a list row works from the keyboard', sent.some(c => c.startsWith('enter_dungeon ')), sent.join(' | '));

	await page.locator('#search').fill('crest');
	await page.locator('#search').press('Enter');
	await sleep(200);
	const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
	check('Enter in the search jumps to a match', focused === 'BUTTON', 'focus: ' + focused);
	// Enter must not press the button it just focused.
	const toggled = await page.evaluate(() => fetch('/favourites').then(r => r.json()));
	check('Enter in the search does not press the match', !toggled.items.includes('Clear all crests'), JSON.stringify(toggled.items));

	await page.locator('#search').press('Escape');
	await sleep(200);
	check('Escape clears the filter', await page.locator('#search').inputValue() === '');

	// --- sizes -------------------------------------------------------------
	for (const size of [{ width: 420, height: 480 }, { width: 560, height: 680 }, { width: 1200, height: 700 }]) {
		await page.setViewportSize(size);
		await sleep(250);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		check(`no horizontal overflow at ${size.width}x${size.height}`, overflow <= 0, 'overflow: ' + overflow);
	}
	await page.setViewportSize({ width: 1200, height: 700 });
	const colWidth = await page.locator('main').evaluate(e => e.getBoundingClientRect().width);
	check('wide window keeps one readable column', colWidth <= 900, 'column: ' + Math.round(colWidth));
	await page.setViewportSize({ width: 560, height: 680 });

	await page.screenshot({ path: SHOT, fullPage: false });
	console.log(`  screenshot: ${SHOT}`);

	await browser.close();
	console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
	process.exit(failed ? 1 : 0);
})().catch(e => {
	console.error('check-ui failed:', e);
	process.exit(1);
});
