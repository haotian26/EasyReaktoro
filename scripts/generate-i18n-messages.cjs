// Extract explicit bilingual application messages. User data is never a translation key.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),statics={},patterns=[];
const literal=n=>ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)?n.text:undefined;
function parts(n,sf){if(ts.isTemplateExpression(n)){const chunks=[n.head.text],expressions=[];for(const span of n.templateSpans){expressions.push(span.expression.getText(sf).replace(/\s+/g,''));chunks.push(span.literal.text);}return {chunks,expressions};}const text=literal(n);return text===undefined?undefined:{chunks:[text],expressions:[]};}
for(const file of fs.readdirSync(path.join(root,'src')).filter(f=>/\.tsx?$/.test(f)&&!f.includes('.test.')).sort()){
 const sf=ts.createSourceFile(file,fs.readFileSync(path.join(root,'src',file),'utf8'),ts.ScriptTarget.Latest,true);
 function visit(n){if(ts.isCallExpression(n)&&['t','tr'].includes(n.expression.getText(sf))&&n.arguments.length===2){const zh=parts(n.arguments[0],sf),en=parts(n.arguments[1],sf);if(zh&&en&&zh.chunks.some(x=>/\p{Script=Han}/u.test(x))){if(!zh.expressions.length&&!en.expressions.length){statics[zh.chunks[0]]=en.chunks[0];}else if(zh.expressions.length&&en.expressions.every(x=>zh.expressions.includes(x))){patterns.push({zh:zh.chunks,en:en.chunks,order:en.expressions.map(x=>zh.expressions.indexOf(x))});}}}ts.forEachChild(n,visit);}visit(sf);
}
const unique=[...new Map(patterns.map(p=>[JSON.stringify(p),p])).values()].sort((a,b)=>b.zh.join('').length-a.zh.join('').length);
fs.writeFileSync(path.join(root,'src/i18n-messages.json'),JSON.stringify({statics,patterns:unique},null,2)+'\n');
console.log(`Bilingual messages: ${Object.keys(statics).length} fixed, ${unique.length} parameterized.`);
