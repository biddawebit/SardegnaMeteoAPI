const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// Helper function to build XML from JSON payload
function buildRssXml(data) {
    let title = data.title || "Bollettino Protezione Civile Sardegna";
    let xmlStr = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xmlStr += `<rss version="2.0">\n  <channel>\n`;
    xmlStr += `    <title>Allerte Protezione Civile Sardegna</title>\n`;
    xmlStr += `    <description><![CDATA[${title}]]></description>\n`;

    if (data.zones && data.zones.length > 0) {
        data.zones.forEach(az => {
            xmlStr += `    <item>\n`;
            xmlStr += `      <title><![CDATA[Allerta Zona: ${az.zone}]]></title>\n`;
            xmlStr += `      <pubDate>${new Date().toUTCString()}</pubDate>\n`;
            xmlStr += `      <category><![CDATA[${az.zone}]]></category>\n`;

            let descText = `${title}\n\n`;
            descText += `Zona ${az.zone}\n`;
            descText += `Validità bollettino: dal ${data.startDate} al ${data.endDate}\n\n`;

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
        xmlStr += `    <item>\n`;
        xmlStr += `      <title><![CDATA[Nessuna Allerta]]></title>\n`;
        xmlStr += `      <description><![CDATA[Nessuna criticità identificata in nessuna zona.]]></description>\n`;
        xmlStr += `    </item>\n`;
    }

    xmlStr += `  </channel>\n</rss>`;
    return xmlStr;
}

app.get('/extract', async (req, res) => {
    let browser;
    try {
        const pdfUrl = req.query.pdfUrl;
        if (!pdfUrl) return res.status(400).json({ error: "Parametro pdfUrl mancante." });

        console.log("Avvio Headless Browser per processare:", pdfUrl);

        // Render configuration requires args for no-sandbox
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: "new"
        });

        const page = await browser.newPage();
        
        // Sostituisci questo URL con l'indirizzo live del tuo index.php
        const phpAppUrl = 'https://biddawebproject.it/protcivile-ai/index.php'; // DA AGGIORNARE
        await page.goto(`${phpAppUrl}?auto=1`, { waitUntil: 'networkidle2' });

        // Inserisci l'URL del PDF nell'input box PHP e avvia l'estrazione
        await page.evaluate((pdfLink) => {
            const input = document.getElementById('pdf_url');
            if(input) {
                input.value = pdfLink;
                document.getElementById('extract-form').dispatchEvent(new Event('submit'));
            }
        }, pdfUrl);

        console.log("Attesa completamento caricamento PDF.js lato client...");
        
        // Attendi che il div invisibile riceva l'attributo data-status = 'ready' o 'error'
        await page.waitForSelector('#headless-result[data-status]', { timeout: 30000 });
        
        const resultString = await page.evaluate(() => {
            return document.getElementById('headless-result').innerText;
        });

        const data = JSON.parse(resultString || '{}');
        
        if (data.success) {
            const xmlOutput = buildRssXml(data);
            res.type('application/xml').send(xmlOutput);
        } else {
             res.status(500).type('application/xml').send(`<?xml version="1.0"?><error>${data.error}</error>`);
        }

    } catch (err) {
        console.error("Errore Puppeteer Server-Side:", err);
        res.status(500).type('application/xml').send(`<?xml version="1.0"?><error>${err.message}</error>`);
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Puppeteer Proxy in ascolto sulla porta ${PORT}`));
