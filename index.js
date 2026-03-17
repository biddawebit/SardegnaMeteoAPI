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

app.post('/extract', async (req, res) => {
    try {
        const pdfUrl = req.body.pdfUrl;
        
        if (!pdfUrl) {
            return res.status(400).json({ error: "Campo 'pdfUrl' mancante nel JSON della richiesta." });
        }

        console.log("-----------------------------------------");
        console.log("START API - Scaricando PDF:", pdfUrl);
        
        // 1. Download PDF to Uint8Array safely server-side
        const response = await fetch(pdfUrl, {
             headers: { 'User-Agent': 'Mozilla/5.0 (Node.js API)' }
        });
        
        if (!response.ok) {
            throw new Error(`Errore HTTP durante il download: ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        console.log("PDF scaricato in memoria, avvio PDF.js...");

        // 2. Init PDF.js parsing
        const loadingTask = getDocument({
            data: uint8Array,
            disableFontFace: true,
            standardFontDataUrl: `node_modules/pdfjs-dist/standard_fonts/`
        });
        
        const pdf = await loadingTask.promise;

        let fullText = '';
        const pagesToRead = Math.min(2, pdf.numPages);
        for (let i = 1; i <= pagesToRead; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n\n';
        }
        
        const normalizedText = fullText.replace(/\s+/g, ' ');

        let title = "Titolo non presente.";
        let inizio = "Dato non presente.";
        let fine = "Dato non presente.";
        let inizioAvviso = "Dato non presente.";
        let fineAvviso = "Dato non presente.";
        let alertZonesFound = [];
        
        const patternInizio = /Inizio validit[aà][\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}.*?\d{2}:\d{2})/i;
        const patternFine = /Fine validit[aà][\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}.*?\d{2}:\d{2})/i;
        const patternInizioAvviso = /Inizio avviso[\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}(?:\s*(?:alle\s*)?(?:ore\s*)?\d{2}:\d{2})?)/i;
        const patternFineAvviso = /Fine avviso[\s:,-]{0,10}(\d{2}[\.\/]\d{2}[\.\/]\d{4}(?:\s*(?:alle\s*)?(?:ore\s*)?\d{2}:\d{2})?)/i;

        let mTitle = normalizedText.match(/(AVVISO DI CRITICIT[AÀaà]['’]?.*?)(\s*e BOLLETTINO DI CRITICIT[AÀaà]['’]? REGIONALE)/i);
        if (!mTitle) mTitle = normalizedText.match(/(AVVISO DI CRITICIT[AÀaà]['’]?.*?)(?=Data di emissione|Prot\.|Inizio validit[aà]|IL DIRETTORE)/i);
        if (mTitle) {
            title = mTitle[1].trim();
            if (title.length > 300) title = title.substring(0, 300) + '...';
        } else {
            let mTitleAlt = normalizedText.match(/(AVVISO DI CRITICIT[AÀaà]['’]?.{0,100}?)/i);
            if (mTitleAlt) title = mTitleAlt[1].trim() + " (Titolo parziale)";
        }
        console.log("TITOLO ESTRATTO:", title);

        let mInizio = normalizedText.match(patternInizio);
        if (mInizio) inizio = mInizio[1].replace(/alle|ore/ig, '').replace(/\s{2,}/g, ' ').trim();

        let mFine = normalizedText.match(patternFine);
        if (mFine) fine = mFine[1].replace(/alle|ore/ig, '').replace(/\s{2,}/g, ' ').trim();

        let mInizioAvviso = normalizedText.match(patternInizioAvviso);
        if (mInizioAvviso) inizioAvviso = mInizioAvviso[1].replace(/alle|ore/ig, '').replace(/\s{2,}/g, ' ').trim();

        let mFineAvviso = normalizedText.match(patternFineAvviso);
        if (mFineAvviso) fineAvviso = mFineAvviso[1].replace(/alle|ore/ig, '').replace(/\s{2,}/g, ' ').trim();

        // -------------------------------------------------------------
        // Server-Side Canvas Render
        // -------------------------------------------------------------
        console.log("Avvio render grafico su virtual Canvas...");
        const page1 = await pdf.getPage(1);
        const viewport = page1.getViewport({ scale: 1.5 }); 
        
        const canvasFactory = new NodeCanvasFactory();
        const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
        const ctx = canvasAndContext.context;
        
        await page1.render({ 
            canvasContext: ctx, 
            viewport: viewport,
            canvasFactory: canvasFactory
        }).promise;
        
        console.log("Render completato: Size", viewport.width, "x", viewport.height);
        
        const imgData = ctx.getImageData(0, 0, viewport.width, viewport.height).data;

        function getPixel(x, y) {
            const i = (Math.floor(y) * Math.floor(viewport.width) + Math.floor(x)) * 4;
            return { r: imgData[i], g: imgData[i+1], b: imgData[i+2], a: imgData[i+3] };
        }

        const textContentPage = await page1.getTextContent();
        const items = textContentPage.items.map(it => {
            const pt = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
            return { str: it.str.trim(), x: pt[0], y: pt[1] };
        }).filter(it => it.str.length > 0);

        const hoursKeys = ["14", "18", "21", "0", "3", "6", "9", "12", "15", "Tendenza"];
        let timeHeaders = items.filter(it => hoursKeys.includes(it.str) && it.y < viewport.height / 2);
        
        let yGroups = {};
        timeHeaders.forEach(it => {
            let gy = Math.round(it.y / 10) * 10;
            if(!yGroups[gy]) yGroups[gy] = [];
            yGroups[gy].push(it);
        });
        let bestYStr = Object.keys(yGroups).sort((a,b) => yGroups[b].length - yGroups[a].length)[0];
        let headerRow = bestYStr ? yGroups[bestYStr].sort((a,b) => a.x - b.x) : [];
        console.log("Header time columns found:", headerRow.length);

        let dateHeadersRaw = items.filter(it => it.str.match(/(Sab|Dom|Lun|Mar|Mer|Gio|Ven)\s*,\s*\d{2}\.\d{2}\.\d{4}/i));
        dateHeadersRaw.sort((a,b) => a.x - b.x);
        
        let dateHeaders = [];
        dateHeadersRaw.forEach(dh => {
            let text = dh.str.trim();
            if (!dateHeaders.find(d => d.str === text)) {
                dateHeaders.push({ str: text, x: dh.x });
            }
        });

        let riskNamesList = ["Idrogeologico", "Idraulico", "Temporali", "Neve"];
        let risksRows = items.filter(it => riskNamesList.includes(it.str) && it.x < (headerRow.length > 0 ? headerRow[0].x : viewport.width/2));
        risksRows.sort((a,b) => a.y - b.y);

        let cleanRisks = [];
        risksRows.forEach(r => {
            if(!cleanRisks.find(cr => cr.str === r.str && Math.abs(cr.y - r.y) < 10)) {
                cleanRisks.push(r);
            }
        });
        console.log("Risks labels found:", cleanRisks.length);

        let zoneNamesList = ["Iglesiente", "Campidano", "Montevecchio Pischinappiu", "Flumendosa Flumineddu", "Tirso", "Gallura", "Logudoro"];
        let zonesRows = [];
        items.forEach(it => {
            let matched = zoneNamesList.find(z => it.str.includes(z) || z.includes(it.str));
            if(matched && it.y > (parseInt(bestYStr) || 0)) {
                zonesRows.push({ name: matched, y: it.y, x: it.x });
            }
        });
        zonesRows.sort((a,b) => a.y - b.y);
        
        let cleanZones = [];
        zonesRows.forEach(z => {
            let last = cleanZones[cleanZones.length-1];
            if(last && (z.y - last.y) < 30) return; 
            if(cleanZones.length < 7) cleanZones.push(z);
        });
        console.log("Zones found:", cleanZones.length);

        const levelsMap = {
            'giallo': { name: 'Giallo (Ordinaria criticità)', code: 'giallo' },
            'arancione': { name: 'Arancione (Moderata criticità)', code: 'arancione' },
            'rosso': { name: 'Rosso (Elevata criticità)', code: 'rosso' }
        };

        cleanZones.forEach((zone, zIdx) => {
            let zoneAlerts = [];
            let relevantRisks = cleanRisks.filter(r => Math.abs(r.y - zone.y) < 60);
            let uniqueRisks = [];
            relevantRisks.forEach(r => {
                if(!uniqueRisks.find(ur => ur.str === r.str)) uniqueRisks.push(r);
            });
            
            if(uniqueRisks.length === 0 && cleanRisks.length >= 28) {
                 uniqueRisks = cleanRisks.slice(zIdx*4, zIdx*4 + 4);
            }

            uniqueRisks.forEach(risk => {
                let activeSegments = [];
                let currentDateIdx = 0;

                headerRow.forEach((th, hIdx) => {
                    if (th.str === "Tendenza") return; 
                    
                    if (th.str === "0" && hIdx > 0 && headerRow[hIdx-1].str !== "0") {
                        currentDateIdx++;
                    }
                    
                    let sampleX = th.x + 10; 
                    let sampleY = risk.y - 8; 
                    
                    // DEBUG: DUMP THE MIDDLE OF THE FIRST RISK OF FIRST ZONE
                    if (zIdx === 0 && risk === uniqueRisks[0] && hIdx === 4) {
                        console.log(`\n\n[DEBUG PIXEL] Testing ${zone.name} -> ${risk.str} at ${th.str}:00`);
                        console.log(`[DEBUG PIXEL] Exact coordinate sampled: X:${sampleX}, Y:${sampleY}`);
                        let centerPx = getPixel(sampleX, sampleY);
                        console.log(`[DEBUG PIXEL] Center RGB: (${centerPx.r}, ${centerPx.g}, ${centerPx.b})`);
                    }

                    let foundLevel = null;
                        for(let dx = -4; dx <= 4; dx += 2) {
                            for(let dy = -4; dy <= 4; dy += 2) {
                                let px = getPixel(sampleX + dx, sampleY + dy);
                                
                                // TOLLERANZA ESTREMA PER SERVER LINUX (Vercel/Render)
                                // Giallo
                                if(px.r > 130 && px.g > 130 && px.b < 180 && px.r > px.b + 50) { 
                                    foundLevel = levelsMap['giallo']; 
                                }
                                // Arancione
                                else if(px.r > 130 && px.g > 60 && px.g < 200 && px.b < 150 && px.r > px.g + 30) { 
                                    foundLevel = levelsMap['arancione']; 
                                }
                                // Rosso intenso
                                else if(px.r > 130 && px.g < 100 && px.b < 100) { 
                                    foundLevel = levelsMap['rosso']; 
                                }
                                
                                if(foundLevel) break;
                            }
                            if(foundLevel) break;
                        }

                    if(foundLevel) {
                        let dIdx = Math.min(currentDateIdx, Math.max(0, dateHeaders.length - 1));
                        let dateStrMatch = dateHeaders[dIdx] ? dateHeaders[dIdx].str : (currentDateIdx === 0 ? "Oggi" : "Domani");
                        
                        let endThStr = "00";
                        let nextH = null;
                        for(let i = hIdx + 1; i < headerRow.length; i++) {
                            if (headerRow[i].str !== "Tendenza") {
                                nextH = headerRow[i];
                                break;
                            }
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
                        
                        activeSegments.push({
                            level: foundLevel,
                            startDate: dateStrMatch,
                            endDate: dateStrMatch,
                            start: startTimeStr,
                            end: endTimeStr
                        });
                    }
                });

                let merged = [];
                if (activeSegments.length > 0) {
                    let curr = activeSegments[0];
                    for(let i = 1; i < activeSegments.length; i++) {
                        let nextSeg = activeSegments[i];
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
                
                merged.forEach(m => {
                    let alertLabel = "";
                    if (m.startDate === m.endDate) {
                        alertLabel = m.startDate + " dalle ore " + m.start.replace(':', '.') + " alle ore " + m.end.replace(':', '.');
                    } else {
                        alertLabel = m.startDate + " dalle ore " + m.start.replace(':', '.') + " alle ore " + m.end.replace(':', '.') + " di " + m.endDate;
                    }
                    
                    let existingAlert = zoneAlerts.find(a => a.risk === risk.str && a.level.code === m.level.code);
                    if(existingAlert) {
                        existingAlert.times.push(alertLabel);
                    } else {
                        zoneAlerts.push({ risk: risk.str, level: m.level, times: [alertLabel] });
                    }
                });
            });

            if(zoneAlerts.length > 0) {
                alertZonesFound.push({ zone: zone.name, alerts: zoneAlerts });
            }
        });

        // -------------------------------------------------------------
        // Costruzione XML per Make.com
        // -------------------------------------------------------------
        let xmlStr = '<' + '?xml version="1.0" encoding="UTF-8"?' + '>\n';
        xmlStr += `<rss version="2.0">\n`;
        xmlStr += `  <channel>\n`;
        xmlStr += `    <title>Allerte Protezione Civile Sardegna</title>\n`;
        xmlStr += `    <description><![CDATA[${title}]]></description>\n`;
        
        if (alertZonesFound.length > 0) {
            console.log("ALERT TROVATI. Generazione XML con zone: ", alertZonesFound.length);
            alertZonesFound.forEach(az => {
                xmlStr += `    <item>\n`;
                xmlStr += `      <title><![CDATA[Allerta Zona: ${az.zone}]]></title>\n`;
                xmlStr += `      <pubDate>${new Date().toUTCString()}</pubDate>\n`;
                xmlStr += `      <category><![CDATA[${az.zone}]]></category>\n`;
                
                let descText = `${title}\n\n`;
                descText += `Zona ${az.zone}\n`;
                descText += `Validità bollettino: dal ${inizio} al ${fine}\n\n`;
                
                az.alerts.forEach(al => {
                    let levelEmoji = "";
                    if (al.level.code === "giallo") levelEmoji = "🟡";
                    else if (al.level.code === "arancione") levelEmoji = "🟠";
                    else if (al.level.code === "rosso") levelEmoji = "🔴";
                    
                    descText += `⚠️ Rischio: ${al.risk}\n`;
                    descText += `${levelEmoji} Livello: ${al.level.name}\n`;
                    if (al.times && al.times.length > 0) {
                        descText += `Fasce orarie:\n- 🗓️⏰ ${al.times.join('\n- 🗓️⏰ ')}\n`;
                    }
                    descText += `\n`;
                });
                
                xmlStr += `      <description><![CDATA[${descText.trim()}]]></description>\n`;
                xmlStr += `    </item>\n`;
            });
        } else {
            console.log("NESSUN ALLARME RILEVATO: Restituzione XML vuoto");
            xmlStr += `    <item>\n`;
            xmlStr += `      <title><![CDATA[Nessuna Allerta]]></title>\n`;
            xmlStr += `      <description><![CDATA[Nessuna criticità identificata in nessuna zona.]]></description>\n`;
            xmlStr += `    </item>\n`;
        }
        
        xmlStr += `  </channel>\n`;
        xmlStr += `</rss>`;

        // Mandiamo ad Make.com l'XML finito
        res.type('application/xml');
        res.send(xmlStr);
        
        console.log("Elaborazione e Risposta XML completate con successo.");

    } catch (err) {
        console.error("Errore Generico API:", err);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.get('/debug-image', async (req, res) => {
    try {
        const pdfUrl = req.query.pdfUrl || 'http://www.sardegnaambiente.it/documenti/20_1059_20260305133801.pdf';
        
        const response = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const arrayBuffer = await response.arrayBuffer();
        
        const loadingTask = getDocument({
            data: new Uint8Array(arrayBuffer),
            disableFontFace: true,
            standardFontDataUrl: `node_modules/pdfjs-dist/standard_fonts/`
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        
        const canvasFactory = new NodeCanvasFactory();
        const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
        const ctx = canvasAndContext.context;
        
        await page.render({ 
            canvasContext: ctx, 
            viewport: viewport,
            canvasFactory: canvasFactory
        }).promise;

        const buffer = canvasAndContext.canvas.toBuffer('image/png');
        res.type('image/png');
        res.send(buffer);
        
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

app.get('/debug-ops', async (req, res) => {
    try {
        const pdfUrl = req.query.pdfUrl || 'http://www.sardegnaambiente.it/documenti/20_1059_20260305133801.pdf';
        
        const response = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const arrayBuffer = await response.arrayBuffer();
        
        const loadingTask = getDocument({
            data: new Uint8Array(arrayBuffer),
            disableFontFace: true,
            standardFontDataUrl: `node_modules/pdfjs-dist/standard_fonts/`
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        
        const ops = await page.getOperatorList();
        
        let coloredRects = [];
        let curColor = null;
        
        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            const args = ops.argsArray[i];
            
            // setFillRGBColor
            if (fn === OPS.setFillRGBColor) {
                curColor = { r: Math.round(args[0]*255), g: Math.round(args[1]*255), b: Math.round(args[2]*255) };
            }
            
            // rectangle
            if (fn === OPS.rectangle) {
                if (curColor && (curColor.r > 150 || curColor.g > 100)) { // Capture potential warning colors
                    coloredRects.push({
                        color: curColor,
                        x: args[0],
                        y: args[1], // Note: PDF coordinates are usually from bottom-left
                        w: args[2],
                        h: args[3]
                    });
                }
            }
        }
        
        // Also get some text coordinates for reference
        const textContentPage = await page.getTextContent();
        const texts = textContentPage.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] })).filter(t => t.str.trim().length > 0);
        
        res.json({
            foundRectangles: coloredRects.length,
            rectangles: coloredRects,
            sampleTexts: texts.slice(0, 50)
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`📡 API Estrazione Colori PDF in ascolto sulla porta ${PORT}`);
});
