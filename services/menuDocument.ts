// Extract source text locally; the server only receives bounded text or a compressed photo.
export async function menuSource(file:File):Promise<{text:string}|{mimeType:string;data:string}>{
 if(file.size>10*1024*1024)throw Error('Choose a file under 10 MB.');
 const ext=file.name.toLowerCase().split('.').pop();
 if(['jpg','jpeg','png','webp'].includes(ext||'')){
   const bitmap=await createImageBitmap(file);
   try{
     const scale=Math.min(1,2200/Math.max(bitmap.width,bitmap.height));
     const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
     const ctx=canvas.getContext('2d');if(!ctx)throw Error('Image conversion unavailable.');
     ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
     for(const quality of [.9,.8,.65,.5]){
       const data=canvas.toDataURL('image/jpeg',quality).split(',')[1];
       if(data&&data.length<=850000)return {mimeType:'image/jpeg',data};
     }
     throw Error('Photo too large. Crop to one menu page and retry.');
   }finally{bitmap.close();}
 }
 let text='';
 if(ext==='docx'){
   const m=await import('mammoth');const extract=m.extractRawText||m.default?.extractRawText;text=(await extract({arrayBuffer:await file.arrayBuffer()})).value;
 }else if(ext==='xlsx'){
   const m=await import('exceljs');const Workbook=m.Workbook||m.default?.Workbook;const wb=new Workbook();await wb.xlsx.load(await file.arrayBuffer());
   const rows:string[]=[];wb.eachSheet(sheet=>{if(sheet.rowCount>1000||sheet.columnCount>50)throw Error('Workbook too large.');rows.push(sheet.name);sheet.eachRow(row=>{const cells:string[]=[];row.eachCell({includeEmpty:true},(c,i)=>{if(c.formula)throw Error('Save formula results as values before importing.');cells[i-1]=c.text;});rows.push(cells.join(' | '));});});text=rows.join('\n');
 }else if(ext==='pdf'){
   const pdf=await import('pdfjs-dist');const worker=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');pdf.GlobalWorkerOptions.workerSrc=worker.default;
   const task=pdf.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,enableXfa:false});
   try{const doc=await task.promise;if(doc.numPages>20)throw Error('PDF exceeds 20 pages.');const pages:string[]=[];for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n),content=await page.getTextContent();pages.push(content.items.map(i=>'str' in i?i.str+(i.hasEOL?'\n':' '):'').join(''));page.cleanup();}text=pages.join('\n');}finally{await task.destroy();}
 }else if(['txt','csv'].includes(ext||'')){text=await file.text();}
 else throw Error('Use JPEG, PNG, WebP, Word, Excel, text-based PDF, CSV or TXT. Convert HEIC photos to JPEG first.');
 if(!text.trim())throw Error('No readable text. Upload a clear photograph of each scanned page instead.');
 if(text.length>30000)throw Error('Menu exceeds 30,000 characters. Split into smaller menus.');
 return {text};
}
