import type {DiagramMaterialStages, DiagramMaterialTerm} from './LoopDiagram';

export type FlowCoordinate = {inner:number; outer:number};
export type FlowInput = {term:DiagramMaterialTerm; amount:number; source:DiagramMaterialTerm['source']; from?:FlowCoordinate};
export type FlowSource = {source:FlowInput['source']; from?:FlowCoordinate; inputs:FlowInput[]};
export const flowKey = (p:FlowCoordinate) => `${p.outer}:${p.inner}`;

/** Resolve each destination independently: an arrow is a real material dependency,
 * never an indication of execution order or an assumed end-of-round return. */
export function flowInputs(materials:DiagramMaterialStages, to:FlowCoordinate, positions:number, rounds:number, active:(i:number,o:number)=>boolean):FlowSource[] {
  const {inner:i,outer:o}=to;
  const stage=o===0?(i===0?'first_start':'first_following'):(i===0?'later_start':'later_following');
  const groups:FlowSource[]=[];
  for(const term of materials[stage]) {
    try {
      const amount=term.fractionAt?.(i,o)??term.fraction;
      if(!Number.isFinite(amount)||amount<=0)continue;
      let source=term.source;
      let from:FlowCoordinate|undefined;
      if(source!=='fresh') {
        from=(term.sourceAt?term.sourceAt(i,o):source==='left'?{inner:i-1,outer:o}:source==='above'?{inner:i,outer:o-1}:null)??undefined;
        if(!from||!Number.isInteger(from.inner)||!Number.isInteger(from.outer)||from.inner<0||from.inner>=positions||from.outer<0||from.outer>=rounds||from.outer*positions+from.inner>=o*positions+i||!active(from.inner,from.outer))continue;
        source=from.inner===i-1&&from.outer===o?'left':from.inner===i&&from.outer===o-1?'above':'other';
      }
      let group=groups.find(g=>g.source===source&&g.from?.inner===from?.inner&&g.from?.outer===from?.outer);
      if(!group){group={source,from,inputs:[]};groups.push(group);}
      group.inputs.push({term,amount,source,from});
    } catch { /* An incomplete source must not become a fabricated connection. */ }
  }
  return groups;
}

/** Wrap full labels rather than truncating identities or species lists. */
export function flowTextLines(text:string, limit=22):string[] {
  const lines:string[]=[];
  let line='';
  for(const word of text.split(/\s+/)) {
    if(line&&line.length+word.length+1>limit){lines.push(line);line='';}
    if(word.length>limit) {
      if(line){lines.push(line);line='';}
      let part=word;
      while(part.length>limit){lines.push(part.slice(0,limit));part=part.slice(limit);}
      line=part;
    } else line+=(line?' ':'')+word;
  }
  if(line)lines.push(line);
  return lines;
}
