import * as native from '@earendil-works/pi-durable';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
export * from '@earendil-works/pi-durable';
export const Harness = { async open(storage, options, context) {
  const faux=fauxProvider();
  const response=async (ctx, request) => {
    const users=ctx.messages.filter(message=>message.role==='user');
    const text=users.at(-1)?.content;
    const prompt=typeof text==='string'?text:JSON.stringify(text);
    const target=options.env({cwd:process.cwd()},context);
    void target;
    if(prompt?.includes('hold')) {
      while(!existsSync(join(process.cwd(),'release'))) {
        if(request?.signal?.aborted) throw new Error('Fixture model aborted');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
    appendFileSync(join(process.cwd(),'native-requests'),JSON.stringify({prompt,roles:ctx.messages.map(m=>m.role)})+'\n');
    return fauxAssistantMessage('native:'+prompt);
  };
  faux.setResponses(Array.from({length:30},()=>response));
  options.models.setProvider(faux.provider);
  return native.Harness.open(storage,options,context);
} };
