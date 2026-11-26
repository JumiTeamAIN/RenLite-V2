export const ms = (t: any): number | null => {
  const n = t?.toMillis?.();
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
export const elapsed = (a: any, b: any) => {
  const start = ms(a), end = ms(b);
  return start !== null && end !== null && end >= start ? (end-start)/60000 : null;
};
export const mean = (xs: (number|null)[]) => {
  const valid = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : null;
};
export const inPeriod = (t:any, now:number, days:number) => {
  const n=ms(t); return n!==null && n>=now-days*86400000 && n<=now;
};
export const estimateROI = (count:number, minutes:number, displacement:number, wage:number, monthlyCost:number, days:number) => {
  if (![count,minutes,displacement,wage,monthlyCost,days].every(Number.isFinite) || count<0 || minutes<0 || displacement<0 || displacement>100 || wage<0 || monthlyCost<0 || days<=0) throw new Error('Invalid ROI assumptions');
  const hours=count*minutes*displacement/100/60;
  const value=hours*wage, expense=monthlyCost*days/30, net=value-expense;
  return {hours,value,expense,net,roi:expense>0?net/expense*100:null};
};

export type ResponseTargets = {housekeeping:number;maintenance:number;front_desk:number};
export const responseTarget = (department:string|undefined, targets:ResponseTargets|null|undefined):number|null => {
  const key=department?.trim().toLowerCase();
  const n=key==='housekeeping'?targets?.housekeeping:key==='engineering'||key==='maintenance'?targets?.maintenance:key==='front desk'?targets?.front_desk:undefined;
  return typeof n==='number'&&Number.isFinite(n)&&n>0?n:null;
};
export const responseCompliance=(requests: {department?:string;createdAt?:any;acknowledgedAt?:any;status:string}[],targets:ResponseTargets|null|undefined,now:number)=>{
  let met=0,late=0,overdue=0,pending=0,unknown=0,excluded=0;
  for(const r of requests){
    const target=responseTarget(r.department,targets), start=ms(r.createdAt);
    if(r.status==='cancelled'||target===null){excluded++;continue;}
    if(start===null||start>now){unknown++;continue;}
    const ack=elapsed(r.createdAt,r.acknowledgedAt), ackTime=ms(r.acknowledgedAt);
    if(ack!==null&&ackTime!==null&&ackTime<=now){if(ack<=target)met++;else late++;continue;}
    if(r.acknowledgedAt||['completed','in_progress','acknowledged'].includes(r.status)){unknown++;continue;}
    if((now-start)/60000>target)overdue++;else pending++;
  }
  return {met,late,overdue,pending,unknown,excluded,rate:met+late+overdue>0?100*met/(met+late+overdue):null};
};
