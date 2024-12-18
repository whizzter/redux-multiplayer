__Work in progress__

# Redux-Multiplayer

## What is it?

A hopefully simple multiplayer layer for Redux stores where building a shared
editing experience should be only marginally harder than building a client
Redux app.

## General usage and design

First there are (at least currently) some constraints to simplify the design.

On the client a slice of the store should be dedicated to a shared state
and the messages that mutate it should share a common prefix, this way the
middleware can keep track of what messages to make networked and to control
with time-travel functionality to keep in sync.

On the server the entire store is expected to be driven by external updates
and the entire state is expected to mirror the client slice.

To keep the state in sync and servers happy there are 2 main principles, the
first is that the server is authorative and is only expected to ever process a
message once. It is also expected to replace or reject messages in situations
where _data isn't to be trusted from the client_.

The client on the other hand is expected to be at the whims of the server,
so if the server decides to re-order, rename, rewrite or reject a message the
client library is supposed to fully co-operate with this by replacing, 
reordering or even replacing it's internal state in the store and react
appropriately to this.

Multiple stores/contexts can co-exist on the server.

The library makes use of V7 UUID throughout and it's _highly_ recommended to
avoid numeric keys if objects are shared and use some kind of hard to guess
identifier like random UUID's. 

## Getting started

### Client setup

The library is designed to take care of connection management/replay but leave
things such as authentication to the user with callbacks.

The client is created as an Redux enhancer and is then supplied to the store
when creating, it can pass through other enhancers such as applyMiddleware.

The todoId key in the below code is assumed to be handled by the webapp such as
coming from the route.

```
	applyMultiplayer({ 
		sharedActionPredicate:key=>key.startsWith("todoAction"),
		sharedSlice:"todos",
		storeUrl:"/todosocket/"+todoId,
	 })
```

### Server setup

The server is built to be framework agnostic and only needs to be supplied a 
context key together with the websocket connection.

The setup is in two parts, the first part is to create the server, here the
server takes the reducer to allow it to create new stores, at least 2 extra
functions are prudent to create.

First is the hydration function, this is a function to create stores from a
context key such as an todo-list id that will then be replicated to clients
connecting to that identity.

Second the actionFilter that is meant to mutate server messages so that the
reducer can take extra steps on the server, this extra data _SHOULD_ be in
the form of Symbol keys to avoid the client from being able to inject data.


```
const todoServer = createReduxMultiplayerServer<TodoState,any>({
	reducer:todoReducer,
	hydrate: async (key,client)=>{
        // TODO: read from items from database
        return { items:[] } as TodoState;
    },
    actionFilter:({key,action,schedule,replaceAction})=>{
        return {...action,[@MyServerSymbol]:123}
    }
});

```

The second part of the setup is connecting clients to the server, this is done
in application framework agnostic ways using only a standard websocket such 
that it should be possible to use plain NodeJS, Express, Koa or others.

In your route handler (that responds to the urls specified by storeUrl on the
client), you take the incoming websocket connections and give the url specifier
from the route to the server to facilitate lifecycle management of keyed
stores.

```
	todoServer.connect({
		socket:websocketFromFramework,
		key:urlSuffix
	})
```

## Licence

ISC , 2020-2024 Jonas Lund
