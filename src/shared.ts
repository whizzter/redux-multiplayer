interface ServerToClientAction {
    id:string,
    replacesId?:string;
    action:any;
}

export type ServerToClientMessage =
    // the server has no store by the specified id
    {type:"invalidStore"} |
    // need to authenticate before continuing
    {type:"needAuthentication"} |
    // not authorized to do action
    {type:"badAuthorization",actionId:string} |
    // connected (initial or restart connection)
    {type:"connected",initialState:any} |
    // a resumption was detected, list missed messages
    {type:"resumeConnection",actions:ServerToClientAction[]} |
    // replace-state (needed?)
    {type:"replaceState",state:any} |
    // actions to be processed.
    {type:"actions",actions:ServerToClientAction[]} |
    {type:"replaceAction",fromId:string,toId:string,action:any}|
    {type:"renameId",fromId:string, toId:string}|
    {type:"rejectAction"; message:string; actionId:string;};

export type ClientToServerMessage = 
    {
        type:"connect";
        lastSeen:string;
    } |
    {
        type:"action";
        actionId:string;
        actionData:any;
    }


/**
 * AuthenticationError's should be thrown by server-reducers when unauthenticated users tries to do actions that needs signed in users.
 */
export class AuthenticationError extends Error { }
/**
 * AuthorzationError's should be thrown by server-reducers that cannot do an requested action due to insufficient privilegies for authenticated users. 
 */
export class AuthorizationError extends Error { } 

/**
 * RejectionError's should be thrown by server-reducers to indicate that something is uncorrectably wrong with the action
 */
export class RejectionError extends Error {};