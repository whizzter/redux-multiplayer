import { createStore, Reducer, Store } from "redux";
import WebSocket from "ws"
import { v7 as v7uuid } from "uuid"

import { ServerToClientMessage, ClientToServerMessage, AuthenticationError, AuthorizationError, RejectionError } from "./shared"

const sleep = (ms:number) => {
	return new Promise((res)=>{setTimeout(res,ms)});
}

interface ReduxMPServerIdentity {
    sessionId:string;
    userId:string;
    claims: {
        key: string; 
        value: string; 
    }[];
}

interface ReduxMPServerClientContext {
    contextId:string;
    identity?:ReduxMPServerIdentity;
    sendToClient:(msg:ServerToClientMessage)=>void;
    processFromClient:(msg:ClientToServerMessage)=>void;
    close:()=>void;
}

interface ReduxMPServerContext {
    socketToClient:Map<WebSocket,ReduxMPServerClientContext>;
    store:Store;
    lastAction:string;

    scheduledQueue:(()=>Promise<void>)[];

    schedule:(task:()=>Promise<void>)=>void;
}

interface ActionFilterData<S,A> {
    key:string;
    action:A;
    schedule:(task:()=>Promise<void>)=>void;
    replaceAction:(action:A)=>void;
}

interface ReduxMPServerOptions<S,A> {
    reducer:Reducer<S>;
    hydrate:(key:string,clientIdentity:null|ReduxMPServerIdentity)=>Promise<null|S>;
    actionFilter:(data:ActionFilterData<S,A>)=>A;
}


export const createReduxMultiplayerServer = <S=unknown,A=unknown>(options:ReduxMPServerOptions<S,A>)=>{
    // pendings exist in case multiple clients tries to connect to the same un-realized store
    const pendings = new Map<string,Promise<ReduxMPServerContext|null>>();
    // contexts are loaded/created ones!
    const contexts = new Map<string,ReduxMPServerContext>();

    const createContext = async (key:string) => {
        // check if we have a pending creation of a store with the key
        const pending = pendings.get(key);

        // pending creation, we'll await it's result!
        if (pending!==undefined) {
            return await pending;
        }

        // create a Promise for this creation
        let resolvePending!:(v:ReduxMPServerContext|null)=>void;
        let rejectPending!:(reason:any)=>void;
        pendings.set(key,new Promise<ReduxMPServerContext|null>((res,rej)=>{
            resolvePending = res;
            rejectPending = rej;
        }));

        try {
        // hydrate should always auto-create data for auto-created keys
            const initialData = await options.hydrate(key,null)
            if (!initialData)
                return null;
    
           let contextAwaken = ()=>{};

            const context: ReduxMPServerContext = {
                store:createStore(options.reducer,initialData),
                socketToClient:new Map,
                lastAction:v7uuid(),
                scheduledQueue:[],
                schedule:task=>{
                    context.scheduledQueue.push(task);
                    contextAwaken();
                }
            };

            // Startup a context worker!
            ( async ()=>{
                while(true) {
                    if (context.scheduledQueue.length) {
                        //console.log("##>> Awaken by MSG")
                        const todo = context.scheduledQueue.shift()!;
                        await todo();
                    } else {
                        let wasAwaken = false;
                        await Promise.race([
                            sleep(10000),
                            new Promise(res=>{
                                contextAwaken = ()=>{  wasAwaken=true;   }
                            })
                        ]);
                        contextAwaken = ()=>{}
                    }
                }
            } )();

            contexts.set(key,context);
            resolvePending(context);
            return context;
        } catch (e) {
            rejectPending(e);
        } finally {
            // removing from pending-list regardless of status.
            pendings.delete(key);
        }
    }


    return {
        async connect({socket,key}:{socket:WebSocket, key:string}) {

            const connectionPendingMessages:ClientToServerMessage[] = [];

            const clientContext:ReduxMPServerClientContext 
                = {
                contextId:key,
                sendToClient:msg=>socket.send(JSON.stringify(msg)),
                // initially we will only store them since hydration can take a little while.
                processFromClient: msg=>connectionPendingMessages.push(msg),
                close() {
                    const ctx = contexts.get(key);
                    if (ctx) {
                        const cli = ctx.socketToClient.get(socket);
                        if (cli) {
                            ctx.socketToClient.delete(socket);
                        }
                    }
                    try {
                        socket.close();
                    } catch (e) {}
                }
            };

            socket.onmessage = (evt)=>{
                clientContext.processFromClient(JSON.parse(evt.data as string) as ClientToServerMessage)
            }

            socket.onclose = (evt)=>{
                clientContext.close();
            }

            socket.onerror = (evt)=>{
                console.log("###### Mu ser Err",evt);
            }


            const context = 
                contexts.get(key)
                ?? await createContext(key);

            // could have been a long time to read, check if we're still open before registering.
            if (socket.readyState !== socket.OPEN)
                return;

            if (!context) {
                clientContext.sendToClient({type:"invalidStore"})
                clientContext.close();
                return;
            }

            // // If authorize could be slow, we need to check again that the socket is still open before associating!
            // if (socket.readyState !== socket.OPEN)
            //     return;

            // connect client to context!
            context.socketToClient.set(socket,clientContext);

            //console.log("ContextUUID:"+context.lastAction);

            // replace the process function once we've connected to the context
            clientContext.processFromClient = msg => {
                // TODO: authorize!
                //console.log("MU S Processing:", msg)
                // this is the real process function
                switch (msg.type) {
                    case "connect": {
                        clientContext.sendToClient({
                            type: "connected",
                            initialState: context.store.getState()
                        });
                        break;
                    }
                    case "action": {
                        const next = v7uuid();
                        // if the supplied id is too old or seems to be in the "future" then we'll replace it
                        let id =
                            msg.actionId < context.lastAction || msg.actionId > next
                                ? next
                                : msg.actionId;
                        try {
                            let replacedAction:undefined|A = undefined;

                            const toSend =
                                options.actionFilter
                                ?options.actionFilter({
                                    key,
                                    action:msg.actionData,
                                    schedule:context.schedule,
                                    replaceAction:action=>replacedAction=action
                                 })
                                :msg.actionData;

                            //console.log("Entering client action", msg.actionData);

                            context.store.dispatch(toSend);
                            //console.log("Post Server change:",context.store.getState());
                            if (undefined!=replacedAction) {
                                clientContext.sendToClient({ type: "replaceAction", fromId: msg.actionId, toId: id, action: replacedAction })
                            } else if (id !== msg.actionId) {
                                clientContext.sendToClient({ type: "renameId", fromId: msg.actionId, toId: id })
                            }
                        } catch (e) {
                            if (e instanceof RejectionError) {
                                clientContext.sendToClient({ type:"rejectAction",actionId:msg.actionId, message:e.message});
                            } else if (e instanceof AuthenticationError) {
                                clientContext.sendToClient({ type: "needAuthentication" });
                                return;
                            } else if (e instanceof AuthorizationError) {
                                clientContext.sendToClient({ type: "badAuthorization",actionId:msg.actionId, });
                                return;
                            } else throw e;
                        }

                        break;
                    }
                }
            }

            // now process the pending messages
            for(const pending of connectionPendingMessages) {
                clientContext.processFromClient(pending);
            }
        }
    }
}