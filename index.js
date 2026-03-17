const express = require('express');
const { getDocument, OPS } = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');

const app = express();
app.use(express.json());

// Fake browser environment for PDF.js canvas rendering
class NodeCanvasFactory {
    create(width, height) {
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        
        // INTERCEPT CLEARRECT: Prevent PDF.js from making the canvas transparent
        const originalClearRect = context.clearRect;
        context.clearRect = function(x, y, w, h) {
            originalClearRect.call(this, x, y, w, h);
            this.fillStyle = 'white';
            this.fillRect(x, y, w, h);
        };
        
        context.fillStyle = 'white';
        context.fillRect(0, 0, width, height);
        return { canvas, context };
    }
    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
        canvasAndContext.context.fillStyle = 'white';
        canvasAndContext.context.fillRect(0, 0, width, height);
    }
    destroy(canvasAndContext) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

app.all('/extract', async (req, res) => {
    try {
        const pdfUrl = req.method === 'POST' ? req.body.pdfUrl : req.query.pdfUrl;
        if (!pdfUrl) return res.status(400).json({ error: "pdfUrl missing" });

        console.log("START API - PDF:", pdfUrl);
        const response = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error(`Fetch error: ${response.status}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const loadingTask = getDocument({
            data: uint8Array,
            disableFontFace: true,
            standardFontDataUrl: `node_modules/pdfjs-dist/standard_fonts/`
        });
        const pdf = await loadingTask.promise;
        
        // 1. Text Parsing (First 2 pages)
        let fullText = '';
        for (let i = 1; i <= Math.min(2, pdf.numPages); i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join(' ') + '\n';
        }
        const normalizedText = fullText.replace(/\s+/g, ' ');

        // 2. Metadata Extraction
        const patterns = {
            title: /(AVVISO DI CRITICIT[AÀaà]['’]?.*?)(\s*e BOLLETTINO DI CRITICIT[AÀaà]['’]? REGIONALE|(?=Data di emissione|Prot\.|Inizio validit[aà]|IL DIRETTORE))/i,
            inizio: /Inizio validit[aà][\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}.*?\d{2}:\d{2})/i,
            fine: /Fine validit[aà][\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}.*?\d{2}:\d{2})/i
        };

        const mTitle = normalizedText.match(patterns.title);
        const title = mTitle ? mTitle[1].trim() : "AVVISO DI CRITICITÀ";
        const inizio = (normalizedText.match(patterns.inizio) || [])[1] || "N/A";
        const fine = (normalizedText.match(patterns.fine) || [])[1] || "N/A";

        // 3. PIXEL-PERFECT CLASSIFICATION
        const page1 = await pdf.getPage(1);
        const viewport = page1.getViewport({ scale: 1.5 });
        const canvasFactory = new NodeCanvasFactory();
        const { canvas, context: ctx } = canvasFactory.create(viewport.width, viewport.height);
        
        await page1.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
        const imgBuff = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        const getPixel = (x, y) => {
            const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
            return { r: imgBuff[i], g: imgBuff[i+1], b: imgBuff[i+2] };
        };

        const textContentPage = await page1.getTextContent();
        const items = textContentPage.items.map(it => {
            const pt = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
            return { str: it.str.trim(), x: pt[0], y: pt[1] };
        }).filter(it => it.str.length > 0);

        // Map Layout
        const hoursKeys = ["14", "18", "21", "0", "3", "6", "9", "12", "15"];
        const headerRow = items.filter(it => hoursKeys.includes(it.str) && it.y < viewport.height / 2).sort((a,b) => a.x - b.x);
        const dateHeaders = items.filter(it => it.str.match(/(Sab|Dom|Lun|Mar|Mer|Gio|Ven)\s*,\s*\d{2}/i)).sort((a,b) => a.x - b.x);
        const risksRows = items.filter(it => ["Idrogeologico", "Idraulico", "Temporali", "Neve"].includes(it.str) && it.x < viewport.width/4).sort((a,b) => a.y - b.y);
        const zoneNames = ["Iglesiente", "Campidano", "Montevecchio Pischinappiu", "Flumendosa Flumineddu", "Tirso", "Gallura", "Logudoro"];
        const zonesRows = items.filter(it => zoneNames.some(z => it.str.includes(z))).sort((a,b) => a.y - b.y);

        const levelsMap = {
            g: { code: 'Giallo', r: [200, 255], g: [200, 255], b: [0, 150] },
            a: { code: 'Arancione', r: [200, 255], g: [100, 195], b: [0, 150] },
            r: { code: 'Rosso', r: [200, 255], g: [0, 100], b: [0, 150] }
        };

        const alertZonesFound = [];
        
        // Sampling Loop
        zonesRows.forEach((zone, zIdx) => {
            const zoneAlerts = [];
            const relevantRisks = risksRows.filter(r => Math.abs(r.y - zone.y) < 100).slice(0, 4);
            
            relevantRisks.forEach(risk => {
                const results = [];
                let currentDateIdx = 0;

                headerRow.forEach((th, hIdx) => {
                    if (th.str === "0" && hIdx > 0) currentDateIdx++;
                    
                    const sx = th.x + 10, sy = risk.y - 8;
                    let found = null;
                    
                    // 7x7 scan for extreme robustness
                    for(let dx = -3; dx <= 3; dx++) {
                        for(let dy = -3; dy <= 3; dy++) {
                            const p = getPixel(sx + dx, sy + dy);
                            if (p.r > 200 && p.g > 200 && p.b < 150) found = "🟡 Giallo";
                            else if (p.r > 200 && p.g > 100 && p.g < 195 && p.b < 150) found = "🟠 Arancione";
                            else if (p.r > 200 && p.g < 100 && p.b < 150) found = "🔴 Rosso";
                            if(found) break;
                        }
                        if(found) break;
                    }
                    if(found) results.push({ level: found, hour: th.str, day: dateHeaders[currentDateIdx]?.str || "Oggi" });
                });

                if(results.length > 0) zoneAlerts.push({ risk: risk.str, detections: results });
            });
            if(zoneAlerts.length > 0) alertZonesFound.push({ name: zone.str, alerts: zoneAlerts });
        });

        // 4. RSS FEED GENERATION
        let xml = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>';
        xml += `<title>Bollettino Protezione Civile Sardegna</title><description>${title}</description>`;
        
        if (alertZonesFound.length === 0) {
            xml += `<item><title>Nessuna Allerta Attiva</title><description>Nessun rischio identificato per le zone monitorate.</description></item>`;
        } else {
            alertZonesFound.forEach(az => {
                xml += `<item><title>Allerta ${az.name}</title><description><![CDATA[`;
                xml += `Validità: ${inizio} - ${fine}\n\n`;
                az.alerts.forEach(al => {
                    xml += `⚠️ ${al.risk}:\n`;
                    al.detections.forEach(d => xml += `- ${d.level} (ore ${d.hour} del ${d.day})\n`);
                    xml += `\n`;
                });
                xml += `]]></description></item>`;
            });
        }
        xml += '</channel></rss>';
        
        res.type('application/xml').send(xml);
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// DEBUG ENDPOINT: Returns the actual PNG of the rendered PDF
app.get('/debug-image', async (req, res) => {
    try {
        const pdfUrl = req.query.pdfUrl || 'http://www.sardegnaambiente.it/documenti/20_1059_20260305133801.pdf';
        const response = await fetch(pdfUrl);
        const arrayBuffer = await response.arrayBuffer();
        const loadingTask = getDocument({ data: new Uint8Array(arrayBuffer), disableFontFace: true });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvasFactory = new NodeCanvasFactory();
        const { canvas, context: ctx } = canvasFactory.create(viewport.width, viewport.height);
        await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
        res.type('image/png').send(canvas.toBuffer());
    } catch (e) { res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
