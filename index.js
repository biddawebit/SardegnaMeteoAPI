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
        
        // Solid white background
        context.fillStyle = 'white';
        context.fillRect(0, 0, width, height);
        
        // Redirect clearRect to fillRect with white to prevent transparency
        context.clearRect = (x, y, w, h) => {
            context.fillStyle = 'white';
            context.fillRect(x, y, w, h);
        };
        
        return { canvas, context };
    }
    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
        const ctx = canvasAndContext.context;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, width, height);
    }
    destroy(canvasAndContext) {
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
            disableFontFace: false, // Enable embedded fonts for better layout parity
            standardFontDataUrl: `node_modules/pdfjs-dist/standard_fonts/`,
            isEvalSupported: false
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

        // 3. PIXEL-PERFECT HYBRID CLASSIFICATION
        const page1 = await pdf.getPage(1);
        const viewport = page1.getViewport({ scale: 1.5 });
        const canvasFactory = new NodeCanvasFactory();
        const { canvas, context: ctx } = canvasFactory.create(viewport.width, viewport.height);
        
        await page1.render({ 
            canvasContext: ctx, 
            viewport: viewport,
            canvasFactory: canvasFactory
        }).promise;

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;

        const getPixel = (x, y) => {
            const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
            return { r: data[i], g: data[i+1], b: data[i+2] };
        };

        const textContentPage = await page1.getTextContent();
        const items = textContentPage.items.map(it => {
            const pt = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
            return { str: it.str.trim(), x: pt[0], y: pt[1] };
        }).filter(it => it.str.length > 0);

        // Identificazione degli ancoraggi testuali (anche se non renderizzati visivamente)
        const hoursKeys = ["14", "18", "21", "0", "3", "6", "9", "12", "15"];
        const headerRow = items.filter(it => hoursKeys.includes(it.str) && it.y < viewport.height / 2).sort((a,b) => a.x - b.x);
        
        const dateHeadersRaw = items.filter(it => it.str.match(/(Sab|Dom|Lun|Mar|Mer|Gio|Ven)\s*,\s*\d{2}\.\d{2}\.\d{4}/i));
        dateHeadersRaw.sort((a,b) => a.x - b.x);
        const dateHeaders = [];
        dateHeadersRaw.forEach(dh => { if (!dateHeaders.find(d => d.str === dh.str)) dateHeaders.push({ str: dh.str, x: dh.x }); });

        const riskNamesList = ["Idrogeologico", "Idraulico", "Temporali", "Neve"];
        const risksRows = items.filter(it => riskNamesList.includes(it.str) && it.x < viewport.width/4).sort((a,b) => a.y - b.y);
        
        const zoneNamesList = ["Iglesiente", "Campidano", "Montevecchio Pischinappiu", "Flumendosa Flumineddu", "Tirso", "Gallura", "Logudoro"];
        const zonesRows = items.filter(it => zoneNamesList.some(z => it.str.includes(z))).sort((a,b) => a.y - b.y);
        
        const cleanZones = [];
        zonesRows.forEach(z => {
            const matchedName = zoneNamesList.find(name => z.str.includes(name));
            const last = cleanZones[cleanZones.length-1];
            if(!last || (z.y - last.y) >= 30) { if(cleanZones.length < 7) cleanZones.push({ name: matchedName, y: z.y }); }
        });

        const alertZonesFound = [];

        // CAMPIONAMENTO IBRIDO: Usa le coordinate del testo per pescare il colore
        cleanZones.forEach((zone, zIdx) => {
            const zoneAlerts = [];
            const relevantRisks = risksRows.filter(r => Math.abs(r.y - zone.y) < 100).slice(0, 4);
            
            relevantRisks.forEach(risk => {
                const results = [];
                let currentDateIdx = 0;

                headerRow.forEach((th, hIdx) => {
                    if (th.str === "0" && hIdx > 0 && headerRow[hIdx-1].str !== "0") currentDateIdx++;
                    
                    const sx = th.x + 10;
                    const sy = risk.y - 8;
                    let foundLevel = null;
                    
                    // Scansione locale per robustezza contro piccoli disallineamenti come nel PHP
                    for(let dx = -2; dx <= 2; dx++) {
                        for(let dy = -2; dy <= 2; dy++) {
                            const p = getPixel(sx + dx, sy + dy);
                            if(p.r > 200 && p.g > 200 && p.b < 100) foundLevel = { name: "Giallo (Ordinaria criticità)", code: "giallo" };
                            else if(p.r > 200 && p.g > 100 && p.g < 180 && p.b < 100) foundLevel = { name: "Arancione (Moderata criticità)", code: "arancione" };
                            else if(p.r > 200 && p.g < 100 && p.b < 100) foundLevel = { name: "Rosso (Elevata criticità)", code: "rosso" };
                            if(foundLevel) break;
                        }
                        if(foundLevel) break;
                    }

                    if(foundLevel) {
                        const dIdx = Math.min(currentDateIdx, Math.max(0, dateHeaders.length - 1));
                        const dateStrMatch = dateHeaders[dIdx]?.str || (currentDateIdx === 0 ? "Oggi" : "Domani");
                        
                        let endThStr = "00";
                        let nextH = null;
                        for(let i = hIdx + 1; i < headerRow.length; i++) {
                            nextH = headerRow[i];
                            break;
                        }
                        
                        if (nextH) {
                            endThStr = nextH.str;
                        } else {
                            if (th.str === '21') endThStr = '0';
                            else if (th.str === '15') endThStr = '0'; 
                            else {
                                let h = parseInt(th.str);
                                if(!isNaN(h)) {
                                     endThStr = String((h + 3) % 24);
                                }
                            }
                        }
                        
                        let startTimeStr = th.str.padStart(2, '0') + ":00";
                        let endTimeStr = endThStr.padStart(2, '0') + ":00";

                        results.push({ 
                            level: foundLevel, 
                            startDate: dateStrMatch,
                            endDate: dateStrMatch,
                            start: startTimeStr, 
                            end: endTimeStr
                        });
                    }
                });

                // Unisci i segmenti contigui come in PHP per non avere slot duplicati
                let merged = [];
                if (results.length > 0) {
                    let curr = results[0];
                    for(let i = 1; i < results.length; i++) {
                        let nextSeg = results[i];
                        let sameDayCont = (curr.level.code === nextSeg.level.code && curr.endDate === nextSeg.startDate && curr.end === nextSeg.start);
                        let crossMidnightCont = (curr.level.code === nextSeg.level.code && curr.end === "00:00" && nextSeg.start === "00:00");
                        
                        if (sameDayCont || crossMidnightCont) {
                            curr.end = nextSeg.end;
                            curr.endDate = nextSeg.endDate;
                        } else {
                            merged.push(curr);
                            curr = nextSeg;
                        }
                    }
                    merged.push(curr);
                }

                if(merged.length > 0) {
                    // Aggregazione per item XML
                    zoneAlerts.push({ risk: risk.str, detections: merged });
                }
            });
            if(zoneAlerts.length > 0) alertZonesFound.push({ zone: zone.name, alerts: zoneAlerts });
        });

        // 4. GENERAZIONE FEED RSS/XML
        let xml = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>';
        xml += `<title>Bollettino Protezione Civile Sardegna</title><description><![CDATA[${title}]]></description>`;
        
        if (alertZonesFound.length === 0) {
            xml += `<item><title>Nessuna Allerta Attiva</title><description>Nessun rischio identificato per le zone monitorate.</description></item>`;
        } else {
            alertZonesFound.forEach(az => {
                xml += `<item><title><![CDATA[Allerta Zona: ${az.zone}]]></title><description><![CDATA[`;
                xml += `Validità: dal ${inizio} al ${fine}\n\n`;
                az.alerts.forEach(al => {
                    const level = al.detections[0].level;
                    const emoji = level.code === "giallo" ? "🟡" : (level.code === "arancione" ? "🟠" : "🔴");
                    xml += `${emoji} Rischio: ${al.risk} (${level.name})\n`;
                    al.detections.forEach(d => {
                        let alertLabel = "";
                        if (d.startDate === d.endDate) {
                            alertLabel = d.startDate + " dalle ore " + d.start.replace(':', '.') + " alle ore " + d.end.replace(':', '.');
                        } else {
                            alertLabel = d.startDate + " dalle ore " + d.start.replace(':', '.') + " alle ore " + d.end.replace(':', '.') + " di " + d.endDate;
                        }
                        xml += `- 🗓️⏰ ${alertLabel}\n`;
                    });
                    xml += `\n`;
                });
                xml += `]]></description></item>`;
            });
        }
        xml += '</channel></rss>';
        
        res.type('application/xml').send(xml);
        console.log("Feed XML generato con successo (Metodo Ibrido).");
        
        res.type('application/xml').send(xml);
        console.log("Feed XML generato con successo (Metodo Ibrido).");
        
    } catch (err) {
        console.error("Errore /extract:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint automatico richiesto per Make.com
app.get('/auto-extract', async (req, res) => {
    try {
        console.log("Avvio AUTO-EXTRACT dal feed Regionale...");
        
        // 1. Scarica l'XML
        const feedUrl = 'https://www.sardegnaambiente.it/servizi/allertediprotezionecivile/rss/idrogeologico.xml';
        const response = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error(`Errore di connessione al Feed XML: ${response.status}`);
        
        const xmlText = await response.text();
        
        // 2. Parsa l'XML usando regex (per non richiedere dipendenze esterne come fast-xml-parser o xml2js)
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        let targetPdfUrl = null;
        let foundTitle = "";
        
        while ((match = itemRegex.exec(xmlText)) !== null) {
            const itemContent = match[1];
            
            // Estrai titolo e link dell'item
            const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
            const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
            
            if (titleMatch && linkMatch) {
                const titleStr = titleMatch[1].trim();
                const linkStr = linkMatch[1].trim();
                
                // Cerca solo gli "Avviso di Criticità" 
                if (titleStr.toLowerCase().includes("avviso di criticita") || 
                    titleStr.toLowerCase().includes("avviso di criticità") ||
                    titleStr.toLowerCase().includes("bollettino di criticita") || 
                    titleStr.toLowerCase().includes("bollettino di criticità")) {
                    
                    targetPdfUrl = linkStr.replace(/ /g, '%20');
                    foundTitle = titleStr;
                    break; // Trovato il più recente, mi fermo
                }
            }
        }
        
        if (!targetPdfUrl) {
            return res.status(404).json({ success: false, error: "Nessun Avviso o Bollettino di Criticità trovato nell'XML." });
        }
        
        console.log(`Trovato PDF da analizzare: [${foundTitle}] - ${targetPdfUrl}`);
        
        // 3. Richiama l'estrattore passandogli l'URL trovato (simula una chiamata interna)
        // Crea un mock request inietandogli il file
        const internalReq = { method: 'GET', query: { pdfUrl: targetPdfUrl } };
        
        // Dobbiamo estrarre la logica di /extract in una funzione per riutilizzarla pulita
        // Siccome l'abbiamo incorporata nella rotta, posso fare un fetch a me stesso
        // Ma per non bloccare process.env.PORT, lo importo così:
        const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
        const extractRes = await fetch(`${baseUrl}/extract?pdfUrl=${encodeURIComponent(targetPdfUrl)}`);
        
        if (!extractRes.ok) {
            const errText = await extractRes.text();
            throw new Error(`Errore durante l'estrazione OCR/PDF: ${errText}`);
        }
        
        // Restituisci a Make.com il risultato in JSON se preferisci, oppure l'XML generato.
        // L'API /extract al momento restituisce XML. In Make.com ti è utile JSON.
        // Convertiamo al volo la risposta JSON se Make.com lo predilige? 
        // L'utente aveva l'XML come stringa ma con JS ha un output. Mando indietro l'XML che Make.com sa parsare
        const finalXml = await extractRes.text();
        res.type('application/xml').send(finalXml);
        
    } catch (err) {
        console.error("Errore /auto-extract:", err);
        res.status(500).json({ success: false, error: err.message });
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
