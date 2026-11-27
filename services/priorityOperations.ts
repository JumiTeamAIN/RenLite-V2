import type {Request,Session} from '../types';
export const isOutstanding=(r:Pick<Request,'status'>)=>!['completed','cancelled'].includes(r.status);
export function priorityRank(r:Pick<Request,'priority'>){return r.priority==='urgent'?2:r.priority==='high'?1:0;}
const millis=(t:Request['createdAt']|undefined)=>{const n=t?.toMillis?.();return typeof n==='number'&&Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;};
export function compareRequests(a:Request,b:Request){
 const ao=isOutstanding(a),bo=isOutstanding(b);
 if(ao!==bo)return ao?-1:1;
 if(!ao)return millis(b.createdAt)-millis(a.createdAt)||a.id.localeCompare(b.id);
 return priorityRank(b)-priorityRank(a)||millis(a.createdAt)-millis(b.createdAt)||a.id.localeCompare(b.id);
}
export function outstandingPriorities(requests:Request[]){
 const bySession=new Map<string,number>();
 for(const r of requests){if(isOutstanding(r)){bySession.set(r.sessionId,Math.max(bySession.get(r.sessionId)||0,priorityRank(r)));}}
 return bySession;
}
export function compareSessions(a:Session,b:Session,priorities:Map<string,number>){
 return (priorities.get(b.id)||0)-(priorities.get(a.id)||0)||Number(b.status==='awaiting_human'||b.status==='escalated'||b.isUnread)-Number(a.status==='awaiting_human'||a.status==='escalated'||a.isUnread)||(b.lastUpdatedAt?.toMillis?.()||0)-(a.lastUpdatedAt?.toMillis?.()||0)||a.id.localeCompare(b.id);
}
export function newUrgentIds(previous:Set<string>,requests:Request[]){
 return requests.filter(r=>isOutstanding(r)&&priorityRank(r)===2&&!previous.has(r.id)).map(r=>r.id);
}
