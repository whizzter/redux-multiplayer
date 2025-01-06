import { Action, createStore, Reducer, Store } from "redux";
import WebSocket from "ws";
import { v7 as v7uuid } from "uuid";

// await crypto.subtle.generateKey({name:"RSA-PSS",modulusLength:4096,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"])

import { ServerToClientMessage, ClientToServerMessage } from "./shared";
import {
  createGenParamContext,
  defaultLoadOrInitNodeKeypair,
  PEMCryptoKeyPair,
} from "./serverUUIDv7";
import {
  isUUIDv7,
  newUUIDv7Bytes,
  newUUIDv7String,
  parseUUIDString,
  SerializedGenerationParams,
  signedInfoToUuid7GenParams,
  getUUIDv7SeqNo,
  getUUIDv7Timestamp,
  UUIDGeneratorState,
} from "./sharedUUIDv7";

const sleep = (ms: number) => {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
};

interface ReduxMPServerIdentity {
  sessionId: string;
  userId: string;
  claims: {
    key: string;
    value: string;
  }[];
}

interface ReduxMPServerClientContext {
  autoClientId: string;
  clientId?: string;
  contextId: string;
  uuidParams?: SerializedGenerationParams;
  uuidGenState?: UUIDGeneratorState;
  identity?: ReduxMPServerIdentity;
  sendToClient: (msg: ServerToClientMessage) => void;
  processFromClient: (msg: ClientToServerMessage) => void;
  close: () => void;
}

interface ReduxMPServerContext {
  socketToClient: Map<WebSocket, ReduxMPServerClientContext>;
  store: Store;
  lastAction: string;

  scheduledQueue: (() => Promise<void>)[];

  schedule: (task: () => Promise<void>) => void;
}

export interface MPServerActionFilterContext<S, A> {
  key: string;
  getState(): S;
  schedule: (task: () => Promise<void>) => void;
  verifyUUID: (uuid: string) => boolean;
}

interface MPFilterFaultAction {
  type: "reject" | "needAuth" | "badAuthh";
  message: string;
}

type ReduxMPServerActionFilter<S, A> = (
  ctx: MPServerActionFilterContext<S, A>,
  data: A
) => "reject" | "needAuth" | "badAuth" | MPFilterFaultAction | Promise<A> | A;

interface ReduxMPServerOptions<S, A> {
  // function to hydrate a default-object
  hydrate: (
    key: string,
    clientIdentity: null | ReduxMPServerIdentity
  ) => Promise<null | S>;
  // action-filter to run on all incoming messages before passing them on to the accepted state.
  actionFilter: ReduxMPServerActionFilter<S, A>;
  // the reducer that updates the state for clients (and server)
  reducer: Reducer<S>;

  // optional:
  log?: (...args: any[]) => void;
  keyPair?: PEMCryptoKeyPair;
}

export const createReduxMultiplayerServer = <S = unknown, A = unknown>(
  options: ReduxMPServerOptions<S, A>
) => {
  const log = options.log ?? console.log;

  const keyPair =
    options?.keyPair ?? defaultLoadOrInitNodeKeypair({ log: options?.log });

  const gpContext = createGenParamContext(keyPair);

  // pendings exist in case multiple clients tries to connect to the same un-realized store
  const pendings = new Map<string, Promise<ReduxMPServerContext | null>>();
  // contexts are loaded/created ones!
  const contexts = new Map<string, ReduxMPServerContext>();

  const createContext = async (key: string) => {
    // check if we have a pending creation of a store with the key
    const pending = pendings.get(key);

    // pending creation, we'll await it's result!
    if (pending !== undefined) {
      return await pending;
    }

    // create a Promise for this creation
    let resolvePending!: (v: ReduxMPServerContext | null) => void;
    let rejectPending!: (reason: any) => void;
    pendings.set(
      key,
      new Promise<ReduxMPServerContext | null>((res, rej) => {
        resolvePending = res;
        rejectPending = rej;
      })
    );

    try {
      // hydrate should always auto-create data for auto-created keys
      const initialData = await options.hydrate(key, null);
      if (!initialData) return null;

      let contextAwaken = () => {};

      const context: ReduxMPServerContext = {
        store: createStore(options.reducer, initialData),
        socketToClient: new Map(),
        lastAction: v7uuid(),
        scheduledQueue: [],
        schedule: (task) => {
          context.scheduledQueue.push(task);
          contextAwaken();
        },
      };

      // Startup a context worker!
      (async () => {
        while (true) {
          if (context.scheduledQueue.length) {
            //console.log("##>> Awaken by MSG")
            const todo = context.scheduledQueue.shift()!;
            await todo();
          } else {
            let wasAwaken = false;
            await Promise.race([
              sleep(10000),
              new Promise((res) => {
                contextAwaken = () => {
                  wasAwaken = true;
                  res(null);
                };
              }),
            ]);
            contextAwaken = () => {};
          }
        }
      })();

      contexts.set(key, context);
      resolvePending(context);
      return context;
    } catch (e) {
      rejectPending(e);
    } finally {
      // removing from pending-list regardless of status.
      pendings.delete(key);
    }
  };

  return {
    list() {
      return [...contexts.entries()].map((e) => ({
        key: e[0],
        getState: () => e[1].store.getState(),
        clients: () =>
          [...e[1].socketToClient.entries()].map((cl) => ({
            id: cl[1].clientId ?? cl[1].autoClientId,
            close: () => cl[0].close(),
          })),
      }));
    },
    async connect({ socket, key }: { socket: WebSocket; key: string }) {
      const connectionPendingMessages: ClientToServerMessage[] = [];

      const clientContext: ReduxMPServerClientContext = {
        autoClientId: v7uuid(),
        clientId: undefined,
        contextId: key,
        sendToClient: (msg) => socket.send(JSON.stringify(msg)),
        // initially we will only store them since hydration can take a little while.
        processFromClient: (msg) => connectionPendingMessages.push(msg),
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
        },
      };

      socket.onmessage = (evt) => {
        clientContext.processFromClient(
          JSON.parse(evt.data as string) as ClientToServerMessage
        );
      };

      socket.onclose = (evt) => {
        //console.log("### MU SER, Sock: Onclose:",evt)
        // TODO: add some kind of time-out for re-connection where we won't require re-authorization to simplify login flows.
        clientContext.close();
      };

      socket.onerror = (evt) => {
        console.log("###### Mu ser Err", evt);
      };

      const context = contexts.get(key) ?? (await createContext(key));

      // could have been a long time to read, check if we're still open before registering.
      if (socket.readyState !== socket.OPEN) return;

      if (!context) {
        clientContext.sendToClient({ type: "invalidStore" });
        clientContext.close();
        return;
      }

      // // If authorize could be slow, we need to check again that the socket is still open before associating!
      // if (socket.readyState !== socket.OPEN)
      //     return;

      // connect client to context!
      context.socketToClient.set(socket, clientContext);

      //console.log("ContextUUID:"+context.lastAction);

      const filterContext: MPServerActionFilterContext<S, A> = {
        getState: () => context.store.getState() as S,
        key,
        schedule(task: () => Promise<void>) {
          context.schedule(task);
        },
        verifyUUID(uuid) {
          if (!clientContext.uuidGenState) return false;
          const parsed = parseUUIDString(uuid);
          if (!parsed || !isUUIDv7(parsed)) return false;
          const ts = getUUIDv7Timestamp(parsed);
          const seq = getUUIDv7SeqNo(parsed);
          const checked = newUUIDv7Bytes(clientContext.uuidGenState, ts, seq);
          if (checked.length !== parsed.length) return false;
          for (let i = 0; i < checked.length; i++)
            if (checked[i] !== parsed[i]) return false;
          return true;
        },
      };

      // replace the process function once we've connected to the context
      clientContext.processFromClient = (msg) => {
        // TODO: authorize!
        //console.log("MU S Processing:", msg)
        // this is the real process function
        switch (msg.type) {
          case "connect": {
            if (msg.clientId) {
              // TODO: We might use the supplied client id on reconnects.
              clientContext.clientId = msg.clientId;
            }
            if (msg.lastSeen !== "") {
              // if lastSeen is within the recent history then we will try re-sending instead of sending a complete state!
            }

            if (msg.uuidParams) {
              if (!gpContext.verify(msg.uuidParams)) {
                log(
                  "##### INVALID UUID PARAMS, FORCING A NEW PARAMS FOR CLIENT"
                );
                msg.uuidParams = gpContext.makeSigned();
              }
            }

            const uuidParams = msg.uuidParams ?? gpContext.makeSigned();

            clientContext.uuidParams = uuidParams;
            clientContext.uuidGenState = signedInfoToUuid7GenParams(uuidParams);

            clientContext.sendToClient({
              type: "connected",
              initialState: context.store.getState(),
              clientId: clientContext.clientId ?? clientContext.autoClientId,
              uuidParams,
            });
            break;
          }
          case "action": {
            // ignore non-object messages.
            if ("object" !== typeof msg.actionData) return;

            const next = v7uuid();
            // if the supplied id is too old or seems to be in the "future" then we'll replace it
            let id =
              msg.actionId < context.lastAction || msg.actionId > next
                ? next
                : msg.actionId;

            console.log("Client Msg:", msg.actionId, msg.actionData);

            const filteredAction = options.actionFilter
              ? options.actionFilter(filterContext, msg.actionData)
              : msg.actionData;

            const filteredType = filteredAction?.type ?? filteredAction;
            switch (filteredType) {
              case "reject":
              case "needAuth":
              case "badAuth": {
                const respTypes = {
                  needAuth: "needAuthentication",
                  badAuth: "badAuthorization",
                  reject: "rejectAction",
                };
                const respType = respTypes[
                  filteredType as keyof typeof respTypes
                ] as "needAuthentication" | "badAuthorization" | "rejectAction";

                clientContext.sendToClient({
                  type: respType,
                  actionId: msg.actionId,
                  message:
                    filteredAction?.message ??
                    "no extra message given for " + respType,
                });
                return;
              }
            }

            const isReplaced = filteredAction !== msg.actionData;

            //console.log("Entering client action", msg.actionData);

            context.store.dispatch(filteredAction);
            //console.log("Post Server change:",context.store.getState());
            if (isReplaced) {
              clientContext.sendToClient({
                type: "replaceAction",
                fromId: msg.actionId,
                toId: id,
                action: filteredAction,
              });
            } else if (id !== msg.actionId) {
              clientContext.sendToClient({
                type: "renameId",
                fromId: msg.actionId,
                toId: id,
              });
            } else {
              clientContext.sendToClient({
                type: "ackAction",
                id: msg.actionId,
              });
            }
            // now send to all other clients as well.
            for (let [sock, iterClient] of context.socketToClient) {
              if (iterClient.autoClientId === clientContext.autoClientId)
                continue;
              iterClient.sendToClient({
                type: "action",
                action: filteredAction,
                id,
              });
            }

            break;
          }
        }
      };

      // now process the pending messages
      for (const pending of connectionPendingMessages) {
        clientContext.processFromClient(pending);
      }
    },
  };
};
