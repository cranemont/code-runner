import express from "express";
import { createServer } from "http"
import { Server as socketServer } from "socket.io"
import { spawn } from "node-pty";
import bodyParser from 'body-parser'
import cors from 'cors'
import expSession from "express-session";
import ioSession from "express-socket.io-session";
import { RateLimiterMemory } from "rate-limiter-flexible";
import nopt from "nopt";

import morgan from 'morgan';
const combined = ':remote-addr ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
const morganFormat = process.env.NODE_ENV !== "production" ? "dev" : combined;
// morgan 출력 형태 server.env에서 NODE_ENV 설정 production : 배포 dev : 개발

import { cleanUp } from "./file_manager.js";
import compiler from "./compiler.js";
import { purifyPath, makeRunFormat } from "./formatter.js";
import { serverLogger, compileLogger, runLogger } from './logger.js';
import { COMPILE_FAIL, languageSupport } from './constants.js'

const longOpts = {
    "sessionSecret": String,
}
const shortOpts = {
    "s": ["--sessionSecret"],
}
const parsed = nopt(longOpts, shortOpts, process.argv, 2)

const socketLimiter = new RateLimiterMemory({
    points: 20, // Limit each sessionID to 20 requests
    duration: 60, // For 1 minute
});
const compileLimiter = new RateLimiterMemory({
    points: 20, // Limit each sessionID to 20 requests
    duration: 60, // For 1 minute
});
const session = expSession({
    secret: parsed.sessionSecret,
    resave: false,
    saveUninitialized: true
});


const app = express();
const server = createServer(app);
const socketConnection = new socketServer(server, {
    cors: {
        origin: "http://localhost:8080",
        credentials: true
    }
});

app.use(cors({
    origin: "http://localhost:8080",
    credentials: true
}));
app.use(bodyParser.json());
app.use(session);

app.use( morgan(morganFormat, {stream : serverLogger.stream}) );

app.post("/compile", async (req, res) => {
    const dir = Math.random().toString(36).substr(2,11);
    const lang = req.body.lang;
    const code = req.body.code;

    if(!languageSupport.includes(lang)) {
        return res.send({"status": COMPILE_FAIL, "error": "Unsupported Language", "token": ''});
    }

    try {
        await compileLimiter.consume(req.sessionID);
    } catch (err) {
        compileLogger.error(err);
        return res.status(429).send("Too many requests");
    }

    const result = await compiler(dir, lang, code);
    if (result.status === COMPILE_FAIL) {
        await cleanUp(dir);
    }
    return res.send(result);
})


socketConnection.use(ioSession(session, {autoSave: true}))
socketConnection.on("connection", async(socket) => {
    var dir = socket.handshake.query['token'];
    var lang = socket.handshake.query['lang'];
    var sid = socket.handshake.sessionID;

    if(!languageSupport.includes(lang)) {
        socket.emit('stdout', "Unsupported Language");
        socket.disconnect();
    }

    //Check Rate Limit socket connection request
    try {
        await socketLimiter.consume(sid);
    } catch (err) {
        await cleanUp(dir);
        runLogger.error(err);
        socket.emit('stdout', "too many request");
        socket.disconnect();
    }

    try {
        dir = await purifyPath(dir);
        const shell = spawn("/usr/lib/judger/libjudger.so", makeRunFormat(dir, lang));
        shell.onData((data) => {
            socket.emit("stdout", data);
        });
        shell.onExit(async () => {
            await cleanUp(dir);
            socket.disconnect();
        });
        socket.on("stdin", (input) => {
            shell.write(input + "\n");
        });
        socket.on("exit", () => {
            shell.kill();
            socket.disconnect();
        })
    } catch (err) {
        runLogger.error(err);
        socket.disconnect();
    }
});

server.listen(3000, () => {
    serverLogger.info("Server Start Listening on port 3000");
});
