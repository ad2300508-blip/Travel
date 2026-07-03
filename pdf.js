// Generatore PDF minimale, senza dipendenze: una immagine JPEG per pagina A4.

const A4W = 595.28, A4H = 841.89;

// pages: array di { jpeg: Uint8Array, w, h } (w/h in pixel dell'immagine)
export function buildPdf(pages) {
  const chunks = [];   // stringhe o Uint8Array, in ordine
  const offsets = [];  // offset byte di ogni oggetto (1-based)
  let pos = 0;

  const push = data => {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    chunks.push(data);
    pos += data.length;
  };
  const beginObj = n => { offsets[n] = pos; push(`${n} 0 obj\n`); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const n = pages.length;
  const pageObj = i => 3 + i * 3;      // oggetto Page della pagina i
  const imgObj = i => 3 + i * 3 + 1;   // XObject immagine
  const cntObj = i => 3 + i * 3 + 2;   // content stream

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);

  pages.forEach((pg, i) => {
    beginObj(pageObj(i));
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4W} ${A4H}] ` +
      `/Resources << /XObject << /Im${i} ${imgObj(i)} 0 R >> >> /Contents ${cntObj(i)} 0 R >>\nendobj\n`);

    beginObj(imgObj(i));
    push(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
    push(pg.jpeg);
    push('\nendstream\nendobj\n');

    const content = `q ${A4W} 0 0 ${A4H} 0 0 cm /Im${i} Do Q`;
    beginObj(cntObj(i));
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const total = 3 + n * 3;
  const xrefPos = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) {
    push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

export { A4W, A4H };
