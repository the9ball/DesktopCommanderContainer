import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Script } from 'node:vm';

const requireFromApp = createRequire('/usr/src/app/package.json');

/** Verify that the delivered image keeps production dependencies and removes build tooling. */
test('runtime dependency closure excludes development packages', () => {
    for (const packageName of ['decompress', 'download', 'nexe', '@anthropic-ai/mcpb',
        'node-forge', '@modelcontextprotocol/ext-apps', 'typescript']) {
        assert.throws(() => requireFromApp.resolve(packageName), { code: 'MODULE_NOT_FOUND' });
    }
    assert.equal(JSON.parse(readFileSync('/usr/src/app/node_modules/body-parser/package.json')).version, '2.4.0');
    assert.equal(JSON.parse(readFileSync('/usr/src/app/node_modules/markdown-it/package.json')).version, '14.3.3');
    assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), '11.21.2');
    assert.equal(JSON.parse(readFileSync('/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json')).version, '5.0.12');
    assert.equal(JSON.parse(readFileSync('/usr/local/lib/node_modules/npm/node_modules/undici/package.json')).version, '6.29.1');
});

/** Load the Remote Device without invoking its main entrypoint or contacting a service. */
test('Remote Device and its bundled browser UIs survive pruning', async () => {
    await import('/usr/src/app/dist/remote-device/device.js');
    for (const artifact of ['file-preview/preview-runtime.js', 'config-editor/config-editor-runtime.js']) {
        const runtime = readFileSync(`/usr/src/app/dist/ui/${artifact}`, 'utf8');
        assert.ok(runtime.length > 0);
        new Script(runtime, { filename: artifact });
        assert.doesNotMatch(runtime, /\b(?:import|require)\s*\(\s*['"]@modelcontextprotocol\/ext-apps/);
    }
});

/** Encode and decode a WebSocket frame locally and execute the bundled ripgrep binary. */
test('WebSocket transport and ripgrep remain available offline', () => {
    const { Sender, Receiver } = requireFromApp('ws');
    const receiver = new Receiver({ isServer: false });
    let receivedMessage;
    receiver.once('message', (message) => { receivedMessage = message.toString(); });
    for (const chunk of Sender.frame(Buffer.from('offline-frame'), { fin: true, opcode: 1, mask: false })) {
        receiver.write(chunk);
    }
    assert.equal(receivedMessage, 'offline-frame');
    const { rgPath } = requireFromApp('@vscode/ripgrep');
    assert.match(execFileSync(rgPath, ['--version'], { encoding: 'utf8', timeout: 10000 }), /ripgrep/);
});

/** Round-trip an Excel workbook using the production document dependency. */
test('Excel operations work after pruning', async () => {
    const ExcelJS = requireFromApp('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Check').getCell('A1').value = 'offline-cell';
    const loadedWorkbook = new ExcelJS.Workbook();
    await loadedWorkbook.xlsx.load(await workbook.xlsx.writeBuffer());
    assert.equal(loadedWorkbook.getWorksheet('Check').getCell('A1').value, 'offline-cell');
});

/** Exercise PDF serialization and the lazy PDF dependencies without launching a browser. */
test('PDF dependencies work after pruning', async () => {
    const { PDFDocument } = requireFromApp('pdf-lib');
    const document = await PDFDocument.create();
    document.addPage();
    const loadedDocument = await PDFDocument.load(await document.save());
    assert.equal(loadedDocument.getPageCount(), 1);
    assert.equal(typeof requireFromApp('@opendocsg/pdf2md/lib/util/pdf').parse, 'function');
    assert.equal(typeof requireFromApp('md-to-pdf/dist/lib/md-to-pdf.js').convertMdToPdf, 'function');
});

/** Render Markdown, encode an image and round-trip a zip using production packages. */
test('Markdown, image and archive operations work after pruning', async () => {
    const MarkdownIt = requireFromApp('markdown-it');
    assert.match(new MarkdownIt().render('# Offline heading'), /<h1>Offline heading<\/h1>/);
    const sharp = requireFromApp('sharp');
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    assert.equal((await sharp(png).metadata()).format, 'png');
    const PizZip = requireFromApp('pizzip');
    const zip = new PizZip();
    zip.file('check.txt', 'offline-archive');
    const loadedZip = new PizZip(zip.generate({ type: 'nodebuffer' }));
    assert.equal(loadedZip.file('check.txt').asText(), 'offline-archive');
});
