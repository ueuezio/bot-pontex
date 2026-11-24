/**
 * PONTEX BULLS - BOT AUTOMATICO CALCIO LIGURIA
 * Legge classifica e risultati da calcioliguria.com e aggiorna Firebase.
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// 1. CONNESSIONE A FIREBASE
const serviceAccount = require('./chiave-segreta-firebase.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Pulisce i nomi delle squadre (toglie sigle iniziali, accenti e spazi)
function normalizeName(str) {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/^(fci|boc|alm|val|tou|row|mam|pon)\s+/i, '')
        .replace(/[^a-z0-9]/g, '')
        .replace(/ttt/g, 'tt');
}

// Estrae classifica e risultati dall'HTML scaricato
function estraiDatiDaHtml(htmlContent) {
    const $ = cheerio.load(htmlContent);
    const squadreLette = [];
    const risultatiLetti = [];

    $('table tr').each((index, element) => {
        const cols = $(element).find('td');

        // Lettura riga Classifica (Pos, Squadra, Pt, G, V, N, P, Reti, Diff)
        if (cols.length >= 8) {
            const posText = $(cols[0]).text().trim();
            const retiText = $(cols[7]).text().trim();

            if (/^\d+$/.test(posText) && (retiText.includes(':') || retiText.includes('-'))) {
                const nomeGrezzo = $(cols[1]).text().trim().replace(/\s+/g, ' ');
                const punti = parseInt($(cols[2]).text().trim()) || 0;
                const giocate = parseInt($(cols[3]).text().trim()) || 0;
                const vinte = parseInt($(cols[4]).text().trim()) || 0;
                const pareggiate = parseInt($(cols[5]).text().trim()) || 0;
                const perse = parseInt($(cols[6]).text().trim()) || 0;

                const separatore = retiText.includes(':') ? ':' : '-';
                const [gfStr, gsStr] = retiText.split(separatore);
                const golFatti = parseInt(gfStr) || 0;
                const golSubiti = parseInt(gsStr) || 0;

                squadreLette.push({
                    rawName: nomeGrezzo,
                    normName: normalizeName(nomeGrezzo),
                    pt: punti,
                    g: giocate,
                    v: vinte,
                    n: pareggiate,
                    p: perse,
                    gf: golFatti,
                    gs: golSubiti
                });
            }
        }

        // Lettura riga Risultati partita
        const rowText = $(element).text().replace(/\s+/g, ' ').trim();
        const scoreMatch = rowText.match(/(\d+)\s*-\s*(\d+)/);
        if (scoreMatch && cols.length >= 4 && !rowText.includes(':')) {
            const parts = rowText.split(scoreMatch[0]);
            if (parts.length === 2) {
                const casaGrezzo = parts[0].replace(/^\d\d:\d\d\s*/, '').trim();
                const ospiteGrezzo = parts[1].replace(/Guarda il tabellino.*/i, '').trim();

                if (casaGrezzo && ospiteGrezzo) {
                    risultatiLetti.push({
                        casaNorm: normalizeName(casaGrezzo),
                        ospiteNorm: normalizeName(ospiteGrezzo),
                        golCasa: parseInt(scoreMatch[1]),
                        golOspite: parseInt(scoreMatch[2])
                    });
                }
            }
        }
    });

    return { squadreLette, risultatiLetti };
}

async function aggiornaTutto() {
    console.log("🤖 Avvio Bot Pontex Bulls su Calcio Liguria...");
    let browser;

    try {
        const urlCalcioLiguria = 'https://www.calcioliguria.com/campionati.html?p=1277&func=showResultsRank';

        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        // Tentativo 1: Apertura diretta
        console.log(`📡 Tentativo 1 (diretto): ${urlCalcioLiguria}`);
        await page.goto(urlCalcioLiguria, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 5000));
        let htmlContent = await page.content();
        let dati = estraiDatiDaHtml(htmlContent);

        // Tentativo 2: Proxy AllOrigins se il server blocca l'IP estero di GitHub
        if (dati.squadreLette.length === 0) {
            console.log("⚠️ Tentativo 2 tramite proxy AllOrigins...");
            const proxy1 = `https://api.allorigins.win/raw?url=${encodeURIComponent(urlCalcioLiguria)}`;
            await page.goto(proxy1, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await new Promise(r => setTimeout(r, 4000));
            htmlContent = await page.content();
            dati = estraiDatiDaHtml(htmlContent);
        }

        // Tentativo 3: Proxy CodeTabs
        if (dati.squadreLette.length === 0) {
            console.log("⚠️ Tentativo 3 tramite proxy CodeTabs...");
            const proxy2 = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(urlCalcioLiguria)}`;
            await page.goto(proxy2, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await new Promise(r => setTimeout(r, 4000));
            htmlContent = await page.content();
            dati = estraiDatiDaHtml(htmlContent);
        }

        await browser.close();
        browser = null;

        const { squadreLette, risultatiLetti } = dati;
        console.log(`✅ Lette ${squadreLette.length} squadre in classifica e ${risultatiLetti.length} risultati.`);

        if (squadreLette.length === 0) {
            throw new Error("Nessuna squadra trovata nella pagina (blocco firewall attivo).");
        }

        // 4. AGGIORNAMENTO CLASSIFICA SU FIREBASE
        const basePath = db.collection('artifacts').doc('pontex').collection('public').doc('data');
        const standingsSnap = await basePath.collection('standings').get();

        for (const docSnap of standingsSnap.docs) {
            const dbTeam = docSnap.data();
            const dbNorm = normalizeName(dbTeam.name);

            const matchTeam = squadreLette.find(s =>
                s.normName.includes(dbNorm) || dbNorm.includes(s.normName)
            );

            if (matchTeam) {
                await basePath.collection('standings').doc(docSnap.id).update({
                    pt: matchTeam.pt,
                    g: matchTeam.g,
                    v: matchTeam.v,
                    n: matchTeam.n,
                    p: matchTeam.p,
                    gf: matchTeam.gf,
                    gs: matchTeam.gs
                });
                console.log(`📊 Classifica aggiornata: ${dbTeam.name} -> ${matchTeam.pt} pt (${matchTeam.gf}:${matchTeam.gs})`);
            }
        }

        // 5. AGGIORNAMENTO CALENDARIO SU FIREBASE
        if (risultatiLetti.length > 0) {
            const calendarSnap = await basePath.collection('calendar').get();
            for (const docSnap of calendarSnap.docs) {
                const calMatch = docSnap.data();
                const cCasa = normalizeName(calMatch.casa);
                const cOspite = normalizeName(calMatch.ospite);

                const foundRes = risultatiLetti.find(r =>
                    (r.casaNorm.includes(cCasa) || cCasa.includes(r.casaNorm)) &&
                    (r.ospiteNorm.includes(cOspite) || cOspite.includes(r.ospiteNorm))
                );

                if (foundRes) {
                    await basePath.collection('calendar').doc(docSnap.id).update({
                        golCasa: foundRes.golCasa,
                        golOspite: foundRes.golOspite,
                        giocata: true
                    });
                    console.log(`⚽ Calendario aggiornato: ${calMatch.casa} ${foundRes.golCasa} - ${foundRes.golOspite} ${calMatch.ospite}`);
                }
            }
        }

        console.log("🏁 Sincronizzazione con Calcio Liguria completata!");

    } catch (error) {
        if (browser) await browser.close();
        console.error("❌ Errore durante l'esecuzione del bot:", error.message);
        process.exit(1);
    }
}

aggiornaTutto();
