
import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = { api: { bodyParser: false } };
const VERSION = 'formula-vega-final-v4';

function round2(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function normalize(t){ return String(t||'').replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{2,}/g,'\n').trim(); }

function parseMoney(raw){
  if(!raw) return 0;
  let s = String(raw).replace(/\$/g,'').replace(/\s/g,'').replace(/[^\d,.-]/g,'');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if(lastComma >= 0 && lastDot >= 0){
    if(lastComma > lastDot){
      // 2.209.997,65
      s = s.replace(/\./g,'').replace(',','.');
    } else {
      // 2,209,997.65
      s = s.replace(/,/g,'');
    }
  } else if(lastComma >= 0){
    // 2209997,65
    s = s.replace(',','.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Números completos con decimal de 2 dígitos.
// Evita capturar pedazos chicos dentro de 2209997.65.
const MONEY = /(?<![\d.,])-?\$?\s*(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?![\d.,])/g;

function amounts(line){
  const out = [];
  for(const m of String(line||'').matchAll(MONEY)){
    const n = parseMoney(m[0]);
    if(Number.isFinite(n)) out.push(n);
  }
  return out;
}
function lastAmount(line){
  const a = amounts(line);
  return a.length ? a[a.length-1] : 0;
}
function findIdx(lines, rx){ return lines.findIndex(l => rx.test(l)); }
function findAmount(lines, rx){
  for(const l of lines){
    if(rx.test(l)){
      const v = lastAmount(l);
      if(v > 0) return round2(v);
    }
  }
  return 0;
}

function totalsRow(lines){
  let best = null;
  for(const l of lines){
    const a = amounts(l);
    if(a.length >= 3){
      const [habCAp, habSAp, totalDesc] = a.slice(-3);
      if(habCAp > 100000 && totalDesc > 10000){
        best = {
          haberesConAporte: round2(habCAp),
          haberesSinAporte: round2(habSAp),
          totalDescuentos: round2(totalDesc),
          raw: l
        };
      }
    }
  }
  return best;
}

function haberes(lines){
  const t = totalsRow(lines);
  if(t && t.haberesConAporte > 0) return t.haberesConAporte;

  const ipsIndex = findIdx(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  if(ipsIndex > 0){
    let sum = 0;
    for(let i=0; i<ipsIndex; i++){
      const l = lines[i];
      if(/sueldo|basico|básico|jornada|antig[uü]edad|refrigerio|horario/i.test(l)){
        const v = lastAmount(l);
        if(v > 0) sum += v;
      }
    }
    if(sum > 0) return round2(sum);
  }
  return 0;
}

function ioma(lines){
  const index = findIdx(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  if(index < 0) return { index:-1, amount:0 };
  const same = lastAmount(lines[index]);
  if(same > 0) return { index, amount: round2(same) };
  for(let i=index+1; i<=Math.min(index+2, lines.length-1); i++){
    const v = lastAmount(lines[i]);
    if(v > 0) return { index, amount: round2(v) };
  }
  return { index, amount:0 };
}

function stopLine(l){
  return /(son\s+pesos|liquido\s+a\s+pagar|líquido\s+a\s+pagar|neto\s+a\s+cobrar|neto|liquido|líquido|firma|recibi|recibí|banco|cuenta|cbu)/i.test(l);
}
function conceptItem(line){
  const a = amounts(line);
  if(!a.length) return null;
  const amount = round2(a[a.length-1]);
  const concept = clean(String(line).replace(MONEY,'').trim());
  if(!concept || amount <= 0) return null;
  return { concept, amount, raw: line };
}
function ignoreConcept(c){
  return /(hab\.?\s*c\/ap|haberes?|i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|neto|liquido|líquido|total|totales|son\s+pesos)/i.test(c);
}
function discountsBelowIoma(lines, iomaIndex){
  if(iomaIndex < 0) return [];
  const out = [];
  for(let i=iomaIndex+1; i<lines.length; i++){
    const l = clean(lines[i]);
    if(!l) continue;
    if(stopLine(l)) break;
    const item = conceptItem(l);
    if(!item) continue;
    if(ignoreConcept(item.concept)) continue;
    out.push(item);
  }
  return out;
}

function calculate(textRaw){
  const text = normalize(textRaw);
  const lines = text.split('\n').map(clean).filter(Boolean);

  const totals = totalsRow(lines);
  const h = round2(haberes(lines));
  const ips = round2(findAmount(lines, /i\.?\s*p\.?\s*s|ips\s*14/i));
  const io = ioma(lines);
  const iomaAmount = round2(io.amount);

  const lineDiscounts = discountsBelowIoma(lines, io.index);
  const totalByLines = round2(lineDiscounts.reduce((a,b)=>a+b.amount,0));

  let descuentosDebajoIoma = totalByLines;
  let fuente = 'lineas_debajo_ioma';

  if(totals && totals.totalDescuentos > 0 && ips > 0 && iomaAmount > 0){
    const calc = round2(totals.totalDescuentos - ips - iomaAmount);
    if(calc >= 0){
      descuentosDebajoIoma = calc;
      fuente = 'total_descuentos_recibo_menos_ips_ioma';
    }
  }

  const resultadoX = round2(h - ips - iomaAmount);
  const base75 = round2(resultadoX * 0.75);
  const cupo = round2(base75 - descuentosDebajoIoma);
  const manual = !h || !ips || !iomaAmount || !totals;

  return {
    success: true,
    version: VERSION,
    message: manual ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.' : 'Cupo calculado correctamente.',
    manual_review: manual,
    cupo_final: cupo,
    debug: {
      version: VERSION,
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - (Total descuentos recibo - IPS - IOMA)',
      fuente_descuentos: fuente,
      totals_row: totals,
      resumen: {
        haberes: h,
        ips,
        ioma: iomaAmount,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: totals ? totals.totalDescuentos : 0
      },
      descuentos_detectados_por_linea: lineDiscounts,
      lineas_cercanas_ioma: lines.slice(Math.max(0, io.index-4), Math.min(lines.length, io.index+18))
    }
  };
}

async function parseForm(req){
  const form = formidable({ multiples:false, keepExtensions:true, maxFileSize:15*1024*1024 });
  return await new Promise((resolve,reject)=>{
    form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
  });
}

export default async function handler(req,res){
  if(req.method !== 'POST') return res.status(405).json({ success:false, message:'Método no permitido.' });
  try{
    const { files } = await parseForm(req);
    const uploaded = files.recibo_pdf;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if(!file) return res.status(400).json({ success:false, message:'No se recibió ningún PDF.' });

    const name = file.originalFilename || file.name || '';
    if(!name.toLowerCase().endsWith('.pdf')) return res.status(400).json({ success:false, message:'Solo se aceptan archivos PDF.' });

    const buffer = fs.readFileSync(file.filepath || file.path);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';

    if(!String(text).trim()){
      return res.status(422).json({ success:false, message:'El PDF no tiene texto seleccionable. Usá el PDF original, no una foto o escaneo.' });
    }

    return res.status(200).json(calculate(text));
  }catch(error){
    return res.status(500).json({ success:false, message:'Error al procesar el PDF.', error:error.message });
  }
}
