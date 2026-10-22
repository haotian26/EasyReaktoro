import {t} from './i18n';

/** Small arithmetic language; never evaluates JavaScript or accesses objects. */
export type ExpressionNode={number:number}|{variable:string}|{operator:string;args:ExpressionNode[]}|{call:string;args:ExpressionNode[]};
export type ParsedExpression={node:ExpressionNode;variables:Set<string>};
const cache=new Map<string,ParsedExpression>();
export function parseExpression(source:string):ParsedExpression{
 const cached=cache.get(source);if(cached)return cached;
 if(!source.trim()||source.length>2000)throw new Error(t('请填写不超过 2,000 字符的数值或公式。','Enter a value or expression of up to 2,000 characters.'));
 const tokens=source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|<=|>=|!=|<>|==|[+*/^(),<>=-]|\S/g)||[];
 if(tokens.length>400)throw new Error(t('公式过长，请简化。','The expression is too long. Simplify it.'));
 let index=0,depth=0;const variables=new Set<string>();
 const fail=():never=>{throw new Error(t(`公式中无法识别「${tokens[index]??'结尾'}」。`,`Unexpected expression token: ${tokens[index]??'end of input'}.`));};
 const accept=(token:string)=>tokens[index]===token?(index++,true):false;
 const primary=():ExpressionNode=>{
  if(++depth>40)throw new Error(t('公式括号嵌套过多。','Too many nested parentheses.'));
  let node:ExpressionNode;
  if(accept('(')){node=comparison();if(!accept(')'))fail();}
  else {const token=tokens[index++];if(/^(?:\d|\.)/.test(token||''))node={number:Number(token)};
   else if(/^[A-Za-z_]\w*$/.test(token||'')){
    if(accept('(')){const args:ExpressionNode[]=[];if(!accept(')')){do{args.push(comparison());}while(accept(','));if(!accept(')'))fail();}node={call:token,args};}
    else {variables.add(token);node={variable:token};}
   }else fail();
  }
  depth--;return node!;
 };
 const unary=():ExpressionNode=>accept('+')?unary():accept('-')?{operator:'neg',args:[unary()]}:power();
 const power=():ExpressionNode=>{const left=primary();return accept('^')?{operator:'^',args:[left,unary()]}:left;};
 const product=():ExpressionNode=>{let node=unary();while(['*','/'].includes(tokens[index])){const op=tokens[index++];node={operator:op,args:[node,unary()]};}return node;};
 const sum=():ExpressionNode=>{let node=product();while(['+','-'].includes(tokens[index])){const op=tokens[index++];node={operator:op,args:[node,product()]};}return node;};
 const comparison=():ExpressionNode=>{let node=sum();if(['<','>','<=','>=','=','==','!=','<>'].includes(tokens[index])){const op=tokens[index++];node={operator:op,args:[node,sum()]};}return node;};
 const node=comparison();if(index!==tokens.length)fail();const result={node,variables};if(cache.size>1000)cache.clear();cache.set(source,result);return result;
}
function arithmetic(op:string,x:number,y:number):number{
 const parts=(n:number)=>{const [m,e='0']=n.toString().split('e');return {n:BigInt(m.replace('.','')),e:Number(e)-(m.includes('.')?m.length-m.indexOf('.')-1:0)};};
 const a=parts(x),b=parts(y);
 if(op==='*')return Number(`${a.n*b.n}e${a.e+b.e}`);
 if(op==='/'){if(y===0)return NaN;const q=parts(Number(a.n)/Number(b.n));return Number(`${q.n}e${q.e+a.e-b.e}`);}
 const exponent=Math.min(a.e,b.e),left=a.n*10n**BigInt(a.e-exponent),right=b.n*10n**BigInt(b.e-exponent);
 return Number(`${op==='+'?left+right:left-right}e${exponent}`);
}
export function evaluateExpression(parsed:ParsedExpression|string,variable:(name:string)=>number,psat?:(temperature:number)=>number):number{
 const root=typeof parsed==='string'?parseExpression(parsed):parsed;
 const visit=(node:ExpressionNode):number=>{
  if('number'in node){if(!Number.isFinite(node.number))throw new Error(t('数值超出范围。','The number is outside the finite range.'));return node.number;}
  if('variable'in node){const value=variable(node.variable);if(!Number.isFinite(value))throw new Error(t('变量没有有效数值。','The variable has no finite value.'));return value;}
  const a=node.args.map(visit);let result:number;
  if('call'in node){
   const fn=node.call;
   if(fn==='Psat'&&a.length===1&&psat)result=psat(a[0]);
   else if(fn==='min'&&a.length>0)result=Math.min(...a);
   else if(fn==='max'&&a.length>0)result=Math.max(...a);
   else if(fn==='list'&&a.length>1&&Number.isInteger(a[0])&&a[0]>=0&&a[0]<a.length-1)result=a[a[0]+1];
   else if(a.length===1&&['abs','sqrt','ln','log10','exp'].includes(fn))result=({abs:Math.abs,sqrt:Math.sqrt,ln:Math.log,log10:Math.log10,exp:Math.exp} as Record<string,(n:number)=>number>)[fn](a[0]);
   else throw new Error(t(`函数 ${fn} 或其参数无效。`,`Invalid function or arguments: ${fn}.`));
  }else {const [x,y]=a;switch(node.operator){case 'neg':result=-x;break;case '+':case '-':case '*':case '/':result=arithmetic(node.operator,x,y);break;case '^':result=x**y;break;case '<':result=+(x<y);break;case '>':result=+(x>y);break;case '<=':result=+(x<=y);break;case '>=':result=+(x>=y);break;case '=':case '==':result=+(x===y);break;case '!=':case '<>':result=+(x!==y);break;default:throw new Error('Invalid operator');}}
  if(!Number.isFinite(result))throw new Error(t('公式没有得到有限数值，请检查除数和函数范围。','The expression did not produce a finite value. Check divisors and function domains.'));return result;
 };
 return visit(root.node);
}
