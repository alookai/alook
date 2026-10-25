import {useCurrentFrame} from 'remotion';
import t from './timing.json';
export function useBotCreationDecision(){const f=useCurrentFrame();return {error:null,isPending:f>=t.approveClick&&f<t.created,variables:{decision:'approve'},mutate:()=>{}};}
