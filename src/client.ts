import {
  Reducer,
  StoreEnhancer,
  Action,
  isAction,
  Dispatch,
  UnknownAction,
  StoreEnhancerStoreCreator,
} from "redux";
import { ClientToServerMessage, ServerToClientMessage } from "./shared";
import { v7 as v7uuid } from "uuid";

import { sha256 } from "./sha256";

interface ReduxMPClientEnhancerOptions {
  sharedActionPredicate: (key: string) => boolean;
  sharedSlice: string;
  storeUrl: string;

  enhancer?: StoreEnhancer;
}

const replacePartKey = "__@redux-multiplayer" as const;

interface ReplacePartAction extends Action<typeof replacePartKey> {
  slice: string;
  data: string;
}

interface ClientState {
  sendToServer: (msg: ClientToServerMessage) => void;

  processFromServer: (msg: ServerToClientMessage) => void;

  lastSeen: string;
  clientId?: string;
  unacknowledgedActions: ReduxActionStates[];
}
interface ReduxActionStates {
  id: string;
  action: any;
  beforeState: any;
  afterState: any;
}

const isHttpAbsolute = (url: string) =>
  url.startsWith("http://") || url.startsWith("https://");

const wsLocationFromSuffix = (suffix: string) => {
  const wsProto = window.location.protocol == "http:" ? "ws:" : "wss:";
  return wsProto + "//" + window.location.host + suffix;
};

const createClient = (opts: ReduxMPClientEnhancerOptions) => {
  // (window as any).jsh = sha256;
  // (window as any).jsht = async () => {
  //     for (let i=0;i<270;i++) {
  //         let samples = 1+(i<11?(1<<i):1000)
  //         //console.log("Doing length:"+i+" samples:"+samples);

  //         for (let j=0;j<samples;j++) {
  //             const src = new Uint8Array(i);
  //             await crypto.getRandomValues(src);
  //             if (j===0) {
  //                 console.log(`First tested:${i} of ${samples}:`,src);
  //             }
  //             const rh = new Uint8Array(await crypto.subtle.digest("SHA-256",src));
  //             const th = sha256(src);
  //             if (rh.length!==th.length) {
  //                 throw new Error(`Diff len ${rh.length} ${th.length}`)
  //             }
  //             for (let k=0;k<rh.length;k++) {
  //                 if (rh[k]!==th[k]) {
  //                     throw new Error(`diff at ${i} ${j} ${k} :: ${rh[k]} != ${th[k]}`)
  //                 }
  //             }
  //         }
  //     }
  // }

  const isHostRelative = opts.storeUrl.startsWith("/");
  const isAbsolute = isHttpAbsolute(opts.storeUrl);

  const wsAddress = isHostRelative
    ? wsLocationFromSuffix(opts.storeUrl)
    : isHttpAbsolute(opts.storeUrl)
      ? opts.storeUrl.replace("http", "ws")
      : (() => {
          throw new Error("Url not host relative nor absolute");
        })();

  const unacknowledgedActions: ReduxActionStates[] = [];

  const state: ClientState = {
    lastSeen: "",
    unacknowledgedActions,

    processFromServer: (msg) => {},
    sendToServer: (msg) => {},
  };
  // start connection-state-machine.
  createSocket();

  return state;

  function createSocket() {
    const socket = new WebSocket(wsAddress);

    socket.onopen = (evt) => {
      // TODO: try to send unacknowledged!
      //console.log("MU WS Connected",evt)
      state.sendToServer = (msg) => socket.send(JSON.stringify(msg));

      state.sendToServer({ type: "connect", lastSeen: state.lastSeen });
    };
    socket.onmessage = (evt) => {
      //console.log("MU WS Msg :",evt.data)
      state.processFromServer(JSON.parse(evt.data) as ServerToClientMessage);
    };
    socket.onclose = (evt) => {
      // TODO
      console.log("MU WS CLOSE:", evt);
    };
    socket.onerror = (evt) => {
      // TODO: connection errors!!
      console.log("MU WS ERROR:", evt);
    };

    return socket;
  }
};

export function applyMultiplayer(
  clientOptions: ReduxMPClientEnhancerOptions
): StoreEnhancer<any> {
  const mpCreateStore: StoreEnhancer<any> = (createStore) => {
    const mpCreateStoreEnhancer: (
      byEnhancer: boolean
    ) => ReturnType<typeof mpCreateStore> =
      (byEnhancer) => (reducer, preloaded) => {
        // if created by an enhancer, we can skip it but if not we will give it a chance to create itself first.
        if (!byEnhancer) {
          if (clientOptions.enhancer) {
            //  return clientOptions.enhancer(myCreateStoreEnhancer)
            return clientOptions.enhancer(mpCreateStoreEnhancer(true))(
              reducer,
              preloaded
            );
          }
        }

        const state = createClient(clientOptions);

        // append a sub-reducer to the store to carry out mutations
        const subReducer: Reducer = (state, action) => {
          if (isAction(action)) {
            switch (action.type) {
              case replacePartKey: {
                const tAction = action as any as ReplacePartAction;
                state = { ...state, [tAction.slice]: tAction.data };
                //console.log("New state!:",newState);
                break; // Pass on replaced state to regular reducer
              }
            }
          }

          return reducer(state, action as any);
        };

        // now create the actual store with our appended reducer
        const store = createStore(subReducer, preloaded);

        const findUnack = (msgId: string) =>
          state.unacknowledgedActions.reduce<{
            v: ReduxActionStates;
            i: number;
          } | null>((p, v, i) => p ?? (v.id === msgId ? { v, i } : null), null);

        state.processFromServer = (msg) => {
          switch (msg.type) {
            case "connected": {
              if (msg.clientId) state.clientId = msg.clientId;
              store.dispatch({
                type: replacePartKey,
                slice: clientOptions.sharedSlice,
                data: msg.initialState,
              } as ReplacePartAction as any);
              break;
            }
            case "action": {
              // TODO: if we have-un-acked we need to rewind!!
              state.lastSeen = msg.id;
              store.dispatch(msg.action as any);
              break;
            }
            case "ackAction": {
              const preLen = state.unacknowledgedActions.length;
              const unackInfo = findUnack(msg.id);
              if (!unackInfo) {
                console.log("Unknown unacked:" + msg.id);
              } else {
                console.log(`Unack at ${unackInfo.i}`, unackInfo.v);
                state.unacknowledgedActions.splice(unackInfo.i, 1);
                const postLen = state.unacknowledgedActions.length;
                console.log("Unack lens:", preLen, postLen);
              }
              break;
            }
            case "rejectAction": {
              console.log("reject act:", msg.actionId, msg.message);
              break;
            }
            case "replaceAction": {
              console.log("Replace act", msg.fromId, msg.toId, msg.action);
              break;
            }
            case "renameId": {
              console.log("Rename-id from server!", msg.fromId, msg.toId);
              break;
            }
          }
        };

        // also patch the returned dispatch to handle capturing of incoming messages and the resulting states!
        const dispatch: Dispatch<UnknownAction> = (action) => {
          const preState = store.getState();

          const disRet = store.dispatch(action);

          if (
            isAction(action) &&
            clientOptions.sharedActionPredicate(action.type)
          ) {
            const id = v7uuid();
            state.unacknowledgedActions.push({
              id,
              action: action,
              beforeState: preState,
              afterState: store.getState(),
            });
            state.sendToServer({
              type: "action",
              actionId: id,
              actionData: action,
            });
            //console.log("MULTIMSG:"+action.type)
          }

          return disRet;
        };

        return { ...store, dispatch };
      };

    return mpCreateStoreEnhancer(false) as any;
  };

  // pre-post apply enhancers?
  return mpCreateStore;
}
