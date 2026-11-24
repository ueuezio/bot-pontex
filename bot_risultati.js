/**
 * PONTEX BULLS - BOT AUTOMATICO CALCIO LIGURIA
 * Legge la classifica e gli ultimi risultati da calcioliguria.com
 * e aggiorna in automatico il database Firebase.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// 1. CONNESSIONE A FIREBASE
const serviceAccount = require('./chiave-segreta-firebase.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Funzione per normalizzare i nomi delle squadre e ignorare errori di battitura sul portale (es. ARCHITTTURA)
function normalizeName(str) {
    return str
        .toLowerCase()
        .replace(/^(fci|boc|alm|val|tou|row|mam|pon)\s+/i, '') // Rimuove la sigla iniziale a 3 lettere
        .replace(/[^a-z0-9]/g, '')
        .replace(/ttt/g, 'tt');
}

async function aggiornaTutto() {
    console.log("🤖 Avvio Bot Pontex Bulls su Calcio Liguria...");

    try {
        const urlCalcioLiguria = 'https://www.calcioliguria.com/campionati.html?p=1277&func=showResultsRank';
        
        console.log(`📡 Scarico dati da: ${urlCalcioLiguria}`);
        const response = await axios.get(urlCalcioLiguria, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const squadreLette = [];
        const risultatiLetti = [];

        // 2. LETTURA TABELLA CLASSIFICA
        // Struttura Calcio Liguria: Pos. | Squadra | P.ti | G | V | N | P | Reti (GF:GS) | Diff.
        $('table tr').each((index, element) => {
            const cols = $(element).find('td');
            
            if (cols.length >= 8) {
                const posText = $(cols[0]).text().trim();
                const retiText = $(cols[7]).text().trim();

                // Verifica che sia una riga della classifica (Posizione numerica e Reti con ":")
                if (/^\d+$/.test(posText) && retiText.includes(':')) {
                    const nomeGrezzo = $(cols[1]).text().trim().replace(/\s+/g, ' ');
                    const punti = parseInt($(cols[2]).text().trim()) || 0;
                    const giocate = parseInt($(cols[3]).text().trim()) || 0;
                    const vinte = parseInt($(cols[4]).text().trim()) || 0;
                    const pareggiate = parseInt($(cols[5]).text().trim()) || 0;
                    const perse = parseInt($(cols[6]).text().trim()) || 0;
                    
                    const [gfStr, gsStr] = retiText.split(':');
                    const golFatti = parseInt(gfStr) || 0;
                    const golSubiti = parseInt(gsStr) || 0;

                    squadreLette.push({
                        rawName: nomeGrezzo,
                        normName: normalizeName(nomeGrezzo),
                        pt: punti, g: giocate, v: vinte, n: pareggiate, p: perse,
                        gf: golFatti, gs: golSubiti
                    });
                }
            }

            // 3. LETTURA TABELLA RISULTATI DELL'ULTIMA GIORNATA
            const rowText = $(element).text().replace(/\s+/g, ' ').trim();
            const scoreMatch = rowText.match(/(\d+)\s*-\s*(\d+)/);
            if (scoreMatch && cols.length >= 4 && !rowText.includes(':')) {
                // Estrae i nomi delle squadre prima e dopo il punteggio
                const parts = rowText.split(scoreMatch[0]);
                if (parts.length === 2) {
                    const casaGrezzo = parts[0].replace(/^\d{2}:\d{2}\s*/, '').trim();
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

        console.log(`✅ Lette ${squadreLette.length} squadre in classifica e ${risultatiLetti.length} risultati.`);

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

        // 5. AGGIORNAMENTO RISULTATO PARTITA NEL CALENDARIO SU FIREBASE
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
        console.error("❌ Errore durante l'esecuzione del bot:", error.message);
        process.exit(1);
    }
}

aggiornaTutto();
