import {invoke} from '@tauri-apps/api/core';
import {encodeDraft} from './draft-json';
import {userMessage} from './user-messages';
export const simulationCall=<T=any,>(action:string,payload:Record<string,unknown>={})=>invoke<T>('simulation_call',{payload:encodeDraft({action,...payload})});
export const simulationError=userMessage;
