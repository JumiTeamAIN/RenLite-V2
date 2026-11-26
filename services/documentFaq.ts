import {parseUploadedFaqs,hasInvalidFaqText,type FaqDraft} from './faqImport';
export function structuredTextFaqs(text:string):FaqDraft[]{
 if(hasInvalidFaqText(text))throw Error('Document contains unreadable characters.');
 const lines=text.split(/\r?\n/).map(l=>l.trim().replace(/^[•●▪○◦]\s*/,'')).filter(Boolean);
 const result:FaqDraft[]=[];
 let question='',answer:string[]=[];
 function flush(){if(question&&answer.length)result.push({question,answer:answer.join('\n')});question='';answer=[];}
 for(const line of lines){
   if(/^Q\s*:/i.test(line)||line.endsWith('?')){
     flush();question=line.replace(/^Q\s*:\s*/i,'');continue;
   }
   if(question)answer.push(line.replace(/^A\s*:\s*/i,''));
 }
 flush();return result;
}
export function reviewFaqs(existing:FaqDraft[],incoming:FaqDraft[]){
 const normalize=(s:string)=>s.trim().toLowerCase().replace(/\s+/g,' ').replace(/[?!.]+$/,'');
 const known=new Map(existing.filter(f=>f.question.trim()).map(f=>[normalize(f.question),f.answer.trim()]));
 const accepted:FaqDraft[]=[];let duplicates=0,conflicts=0;
 for(const f of incoming){
   const question=f.question.trim(),answer=f.answer.trim();
   if(!question||!answer||hasInvalidFaqText(question)||hasInvalidFaqText(answer)||question.length>500||answer.length>1000)throw Error('Invalid or oversized FAQ. No entries added.');
   const key=normalize(question);
   if(known.has(key)){if(known.get(key)===answer)duplicates++;else conflicts++;continue;}
   known.set(key,answer);accepted.push({question,answer});
 }
 return {accepted,duplicates,conflicts};
}
export async function extractFaqFile(file:File):Promise<FaqDraft[]>{
 const ext=file.name.toLowerCase().split('.').pop();
 if(!ext||!['json','csv','txt','docx','xlsx','pdf'].includes(ext))throw Error('Use Word (.docx), Excel (.xlsx), PDF, JSON, CSV or TXT.');
 if(file.size>5*1024*1024)throw Error('Maximum document size is 5 MB.');
 if(['json','csv','txt'].includes(ext))return parseUploadedFaqs(await file.text(),file.name);
 const bytes=await file.arrayBuffer();
 if(ext==='docx'){
   const mammoth=await import('mammoth');
   const doc=await mammoth.extractRawText({arrayBuffer:bytes});
   return structuredTextFaqs(doc.value);
 }
 if(ext==='xlsx'){
   const excel=await import('exceljs');
   const workbook=new excel.Workbook();await workbook.xlsx.load(bytes);
   const pairs:FaqDraft[]=[];
   workbook.eachSheet(sheet=>{
     if(sheet.rowCount>1000||sheet.columnCount>50)throw Error('Workbook exceeds 1000 rows or 50 columns per sheet.');
     let qCol=0,aCol=0;
     sheet.eachRow(row=>{
       if(!qCol||!aCol){
         row.eachCell((cell,col)=>{const v=cell.text.trim().toLowerCase();if(['question','faq','q'].includes(v))qCol=col;if(['answer','response','a'].includes(v))aCol=col;});
         if(qCol&&aCol)return;
         qCol=0;aCol=0;
         if(row.getCell(1).text.trim().endsWith('?')&&row.getCell(2).text.trim()){qCol=1;aCol=2;}else return;
       }
       const q=row.getCell(qCol),a=row.getCell(aCol);
       if(q.formula||a.formula)throw Error('FAQ columns must contain text or values, not formulas.');
       if(q.text.trim()&&a.text.trim())pairs.push({question:q.text.trim(),answer:a.text.trim()});
     });
   });
   return pairs;
 }
 const pdf=await import('pdfjs-dist');
 const worker=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
 pdf.GlobalWorkerOptions.workerSrc=worker.default;
 const task=pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,enableXfa:false});
 try{
   const doc=await task.promise;if(doc.numPages>30)throw Error('PDF exceeds 30 pages.');
   const pages:string[]=[];
   for(let n=1;n<=doc.numPages;n++){
     const page=await doc.getPage(n),content=await page.getTextContent();
     let line='',text='';
     for(const item of content.items){if('str' in item){line+=item.str+' ';if(item.hasEOL){text+=line+'\n';line='';}}}
     pages.push(text+line);page.cleanup();
   }
   const text=pages.join('\n');if(!text.trim())throw Error('No readable text found. Scanned PDFs need OCR before import.');
   return structuredTextFaqs(text);
 }finally{await task.destroy();}
}
