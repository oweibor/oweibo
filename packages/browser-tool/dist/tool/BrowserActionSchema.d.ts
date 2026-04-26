import { z } from 'zod';
export declare const BrowserActionSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"navigate">;
    url: z.ZodString;
    waitUntil: z.ZodOptional<z.ZodEnum<["load", "domcontentloaded", "networkidle"]>>;
}, "strip", z.ZodTypeAny, {
    type: "navigate";
    url: string;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | undefined;
}, {
    type: "navigate";
    url: string;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"click">;
    selector: z.ZodString;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
    clickCount: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "click";
    selector: string;
    button?: "left" | "right" | "middle" | undefined;
    clickCount?: number | undefined;
}, {
    type: "click";
    selector: string;
    button?: "left" | "right" | "middle" | undefined;
    clickCount?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"type">;
    selector: z.ZodString;
    text: z.ZodString;
    delay: z.ZodOptional<z.ZodNumber>;
    clearFirst: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "type";
    selector: string;
    text: string;
    delay?: number | undefined;
    clearFirst?: boolean | undefined;
}, {
    type: "type";
    selector: string;
    text: string;
    delay?: number | undefined;
    clearFirst?: boolean | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    selector: z.ZodOptional<z.ZodString>;
    direction: z.ZodEnum<["up", "down", "left", "right"]>;
    distance: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "scroll";
    direction: "left" | "right" | "up" | "down";
    selector?: string | undefined;
    distance?: number | undefined;
}, {
    type: "scroll";
    direction: "left" | "right" | "up" | "down";
    selector?: string | undefined;
    distance?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"hover">;
    selector: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "hover";
    selector: string;
}, {
    type: "hover";
    selector: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"select">;
    selector: z.ZodString;
    value: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>;
}, "strip", z.ZodTypeAny, {
    value: string | string[];
    type: "select";
    selector: string;
}, {
    value: string | string[];
    type: "select";
    selector: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"check">;
    selector: z.ZodString;
    checked: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    type: "check";
    selector: string;
    checked: boolean;
}, {
    type: "check";
    selector: string;
    checked: boolean;
}>, z.ZodObject<{
    type: z.ZodLiteral<"wait">;
    ms: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "wait";
    ms: number;
}, {
    type: "wait";
    ms: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"wait-for-selector">;
    selector: z.ZodString;
    state: z.ZodOptional<z.ZodEnum<["visible", "hidden", "attached", "detached"]>>;
    timeout: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "wait-for-selector";
    selector: string;
    state?: "visible" | "hidden" | "attached" | "detached" | undefined;
    timeout?: number | undefined;
}, {
    type: "wait-for-selector";
    selector: string;
    state?: "visible" | "hidden" | "attached" | "detached" | undefined;
    timeout?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"submit">;
    selector: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "submit";
    selector: string;
}, {
    type: "submit";
    selector: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    fullPage: z.ZodOptional<z.ZodBoolean>;
    element: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "screenshot";
    fullPage?: boolean | undefined;
    element?: string | undefined;
}, {
    type: "screenshot";
    fullPage?: boolean | undefined;
    element?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"snapshot">;
}, "strip", z.ZodTypeAny, {
    type: "snapshot";
}, {
    type: "snapshot";
}>, z.ZodObject<{
    type: z.ZodLiteral<"extract">;
    selectors: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        query: z.ZodString;
        attribute: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        query: string;
        attribute?: string | undefined;
    }, {
        name: string;
        query: string;
        attribute?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    type: "extract";
    selectors: {
        name: string;
        query: string;
        attribute?: string | undefined;
    }[];
}, {
    type: "extract";
    selectors: {
        name: string;
        query: string;
        attribute?: string | undefined;
    }[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"eval">;
    expression: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "eval";
    expression: string;
}, {
    type: "eval";
    expression: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tab-open">;
    url: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "tab-open";
    url?: string | undefined;
}, {
    type: "tab-open";
    url?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tab-switch">;
    tabId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "tab-switch";
    tabId: string;
}, {
    type: "tab-switch";
    tabId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tab-close">;
    tabId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "tab-close";
    tabId: string;
}, {
    type: "tab-close";
    tabId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tabs-list">;
}, "strip", z.ZodTypeAny, {
    type: "tabs-list";
}, {
    type: "tabs-list";
}>, z.ZodObject<{
    type: z.ZodLiteral<"go-back">;
}, "strip", z.ZodTypeAny, {
    type: "go-back";
}, {
    type: "go-back";
}>, z.ZodObject<{
    type: z.ZodLiteral<"go-forward">;
}, "strip", z.ZodTypeAny, {
    type: "go-forward";
}, {
    type: "go-forward";
}>, z.ZodObject<{
    type: z.ZodLiteral<"reload">;
}, "strip", z.ZodTypeAny, {
    type: "reload";
}, {
    type: "reload";
}>, z.ZodObject<{
    type: z.ZodLiteral<"clear-cookies">;
    domain: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "clear-cookies";
    domain?: string | undefined;
}, {
    type: "clear-cookies";
    domain?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"get-cookies">;
    domain: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "get-cookies";
    domain?: string | undefined;
}, {
    type: "get-cookies";
    domain?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"set-cookies">;
    cookies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
        domain: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        expires: z.ZodOptional<z.ZodNumber>;
        httpOnly: z.ZodOptional<z.ZodBoolean>;
        secure: z.ZodOptional<z.ZodBoolean>;
        sameSite: z.ZodOptional<z.ZodEnum<["Strict", "Lax", "None"]>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        value: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }, {
        name: string;
        value: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    type: "set-cookies";
    cookies: {
        name: string;
        value: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }[];
}, {
    type: "set-cookies";
    cookies: {
        name: string;
        value: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"upload">;
    selector: z.ZodString;
    filePath: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "upload";
    selector: string;
    filePath: string;
}, {
    type: "upload";
    selector: string;
    filePath: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"download">;
    url: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "download";
    url: string;
    filename?: string | undefined;
}, {
    type: "download";
    url: string;
    filename?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"get-url">;
}, "strip", z.ZodTypeAny, {
    type: "get-url";
}, {
    type: "get-url";
}>, z.ZodObject<{
    type: z.ZodLiteral<"get-title">;
}, "strip", z.ZodTypeAny, {
    type: "get-title";
}, {
    type: "get-title";
}>, z.ZodObject<{
    type: z.ZodLiteral<"move-to-upload">;
    sourcePath: z.ZodString;
    filename: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "move-to-upload";
    sourcePath: string;
    filename?: string | undefined;
}, {
    type: "move-to-upload";
    sourcePath: string;
    filename?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"handle-dialog">;
    accept: z.ZodBoolean;
    promptText: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "handle-dialog";
    accept: boolean;
    promptText?: string | undefined;
}, {
    type: "handle-dialog";
    accept: boolean;
    promptText?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"drag-and-drop">;
    sourceSelector: z.ZodString;
    targetSelector: z.ZodString;
    sourceOffset: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    targetOffset: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    steps: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "drag-and-drop";
    sourceSelector: string;
    targetSelector: string;
    sourceOffset?: {
        x: number;
        y: number;
    } | undefined;
    targetOffset?: {
        x: number;
        y: number;
    } | undefined;
    steps?: number | undefined;
}, {
    type: "drag-and-drop";
    sourceSelector: string;
    targetSelector: string;
    sourceOffset?: {
        x: number;
        y: number;
    } | undefined;
    targetOffset?: {
        x: number;
        y: number;
    } | undefined;
    steps?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"mouse-move">;
    x: z.ZodNumber;
    y: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "mouse-move";
    x: number;
    y: number;
}, {
    type: "mouse-move";
    x: number;
    y: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"mouse-down">;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
}, "strip", z.ZodTypeAny, {
    type: "mouse-down";
    button?: "left" | "right" | "middle" | undefined;
}, {
    type: "mouse-down";
    button?: "left" | "right" | "middle" | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"mouse-up">;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
}, "strip", z.ZodTypeAny, {
    type: "mouse-up";
    button?: "left" | "right" | "middle" | undefined;
}, {
    type: "mouse-up";
    button?: "left" | "right" | "middle" | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"switch-to-frame">;
    selector: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "switch-to-frame";
    selector: string;
}, {
    type: "switch-to-frame";
    selector: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"switch-to-main">;
}, "strip", z.ZodTypeAny, {
    type: "switch-to-main";
}, {
    type: "switch-to-main";
}>, z.ZodObject<{
    type: z.ZodLiteral<"intercept-request">;
    urlPattern: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    interceptId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "intercept-request";
    urlPattern: string;
    method?: string | undefined;
    interceptId?: string | undefined;
}, {
    type: "intercept-request";
    urlPattern: string;
    method?: string | undefined;
    interceptId?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"mock-response">;
    interceptId: z.ZodString;
    status: z.ZodOptional<z.ZodNumber>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    body: z.ZodOptional<z.ZodString>;
    bodyEncoding: z.ZodOptional<z.ZodEnum<["utf8", "base64"]>>;
    contentType: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "mock-response";
    interceptId: string;
    status?: number | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    bodyEncoding?: "utf8" | "base64" | undefined;
    contentType?: string | undefined;
}, {
    type: "mock-response";
    interceptId: string;
    status?: number | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    bodyEncoding?: "utf8" | "base64" | undefined;
    contentType?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"remove-intercept">;
    interceptId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "remove-intercept";
    interceptId: string;
}, {
    type: "remove-intercept";
    interceptId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"record-video-start">;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "record-video-start";
    width?: number | undefined;
    height?: number | undefined;
}, {
    type: "record-video-start";
    width?: number | undefined;
    height?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"record-video-stop">;
}, "strip", z.ZodTypeAny, {
    type: "record-video-stop";
}, {
    type: "record-video-stop";
}>, z.ZodObject<{
    type: z.ZodLiteral<"har-start">;
    urlFilter: z.ZodOptional<z.ZodString>;
    omitContent: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "har-start";
    urlFilter?: string | undefined;
    omitContent?: boolean | undefined;
}, {
    type: "har-start";
    urlFilter?: string | undefined;
    omitContent?: boolean | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"har-stop">;
}, "strip", z.ZodTypeAny, {
    type: "har-stop";
}, {
    type: "har-stop";
}>, z.ZodObject<{
    type: z.ZodLiteral<"emulate-device">;
    deviceName: z.ZodOptional<z.ZodString>;
    customDescriptor: z.ZodOptional<z.ZodObject<{
        userAgent: z.ZodString;
        viewport: z.ZodObject<{
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            width: number;
            height: number;
        }, {
            width: number;
            height: number;
        }>;
        deviceScaleFactor: z.ZodOptional<z.ZodNumber>;
        isMobile: z.ZodOptional<z.ZodBoolean>;
        hasTouch: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        userAgent: string;
        viewport: {
            width: number;
            height: number;
        };
        deviceScaleFactor?: number | undefined;
        isMobile?: boolean | undefined;
        hasTouch?: boolean | undefined;
    }, {
        userAgent: string;
        viewport: {
            width: number;
            height: number;
        };
        deviceScaleFactor?: number | undefined;
        isMobile?: boolean | undefined;
        hasTouch?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "emulate-device";
    deviceName?: string | undefined;
    customDescriptor?: {
        userAgent: string;
        viewport: {
            width: number;
            height: number;
        };
        deviceScaleFactor?: number | undefined;
        isMobile?: boolean | undefined;
        hasTouch?: boolean | undefined;
    } | undefined;
}, {
    type: "emulate-device";
    deviceName?: string | undefined;
    customDescriptor?: {
        userAgent: string;
        viewport: {
            width: number;
            height: number;
        };
        deviceScaleFactor?: number | undefined;
        isMobile?: boolean | undefined;
        hasTouch?: boolean | undefined;
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"accessibility-snapshot">;
    rootSelector: z.ZodOptional<z.ZodString>;
    maxDepth: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "accessibility-snapshot";
    rootSelector?: string | undefined;
    maxDepth?: number | undefined;
}, {
    type: "accessibility-snapshot";
    rootSelector?: string | undefined;
    maxDepth?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"log-capture-start">;
}, "strip", z.ZodTypeAny, {
    type: "log-capture-start";
}, {
    type: "log-capture-start";
}>, z.ZodObject<{
    type: z.ZodLiteral<"log-capture-stop">;
}, "strip", z.ZodTypeAny, {
    type: "log-capture-stop";
}, {
    type: "log-capture-stop";
}>, z.ZodObject<{
    type: z.ZodLiteral<"key-chord">;
    keys: z.ZodString;
    count: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    keys: string;
    type: "key-chord";
    count?: number | undefined;
}, {
    keys: string;
    type: "key-chord";
    count?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"set-geolocation">;
    latitude: z.ZodNumber;
    longitude: z.ZodNumber;
    accuracy: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "set-geolocation";
    latitude: number;
    longitude: number;
    accuracy?: number | undefined;
}, {
    type: "set-geolocation";
    latitude: number;
    longitude: number;
    accuracy?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"grant-permissions">;
    permissions: z.ZodArray<z.ZodEnum<["geolocation", "notifications", "camera", "microphone", "midi", "midi-sysex", "background-sync", "ambient-light-sensor", "accelerometer", "gyroscope", "magnetometer", "accessibility-events", "clipboard-read", "clipboard-write", "payment-handler"]>, "many">;
    origin: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "grant-permissions";
    permissions: ("geolocation" | "notifications" | "camera" | "microphone" | "midi" | "midi-sysex" | "background-sync" | "ambient-light-sensor" | "accelerometer" | "gyroscope" | "magnetometer" | "accessibility-events" | "clipboard-read" | "clipboard-write" | "payment-handler")[];
    origin?: string | undefined;
}, {
    type: "grant-permissions";
    permissions: ("geolocation" | "notifications" | "camera" | "microphone" | "midi" | "midi-sysex" | "background-sync" | "ambient-light-sensor" | "accelerometer" | "gyroscope" | "magnetometer" | "accessibility-events" | "clipboard-read" | "clipboard-write" | "payment-handler")[];
    origin?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"revoke-permissions">;
}, "strip", z.ZodTypeAny, {
    type: "revoke-permissions";
}, {
    type: "revoke-permissions";
}>, z.ZodObject<{
    type: z.ZodLiteral<"print-to-pdf">;
    filename: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodEnum<["A4", "Letter"]>>;
    landscape: z.ZodOptional<z.ZodBoolean>;
    printBackground: z.ZodOptional<z.ZodBoolean>;
    margin: z.ZodOptional<z.ZodObject<{
        top: z.ZodOptional<z.ZodString>;
        bottom: z.ZodOptional<z.ZodString>;
        left: z.ZodOptional<z.ZodString>;
        right: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        left?: string | undefined;
        right?: string | undefined;
        top?: string | undefined;
        bottom?: string | undefined;
    }, {
        left?: string | undefined;
        right?: string | undefined;
        top?: string | undefined;
        bottom?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "print-to-pdf";
    filename?: string | undefined;
    format?: "A4" | "Letter" | undefined;
    landscape?: boolean | undefined;
    printBackground?: boolean | undefined;
    margin?: {
        left?: string | undefined;
        right?: string | undefined;
        top?: string | undefined;
        bottom?: string | undefined;
    } | undefined;
}, {
    type: "print-to-pdf";
    filename?: string | undefined;
    format?: "A4" | "Letter" | undefined;
    landscape?: boolean | undefined;
    printBackground?: boolean | undefined;
    margin?: {
        left?: string | undefined;
        right?: string | undefined;
        top?: string | undefined;
        bottom?: string | undefined;
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"load-extension">;
    extensionId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "load-extension";
    extensionId: string;
}, {
    type: "load-extension";
    extensionId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"share-session">;
    ttlSeconds: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "share-session";
    ttlSeconds?: number | undefined;
}, {
    type: "share-session";
    ttlSeconds?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"inject-credentials">;
    serviceId: z.ZodString;
    submitAfterFill: z.ZodOptional<z.ZodBoolean>;
    usernameSelector: z.ZodOptional<z.ZodString>;
    passwordSelector: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "inject-credentials";
    serviceId: string;
    submitAfterFill?: boolean | undefined;
    usernameSelector?: string | undefined;
    passwordSelector?: string | undefined;
}, {
    type: "inject-credentials";
    serviceId: string;
    submitAfterFill?: boolean | undefined;
    usernameSelector?: string | undefined;
    passwordSelector?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"import-cookies">;
    /** Hostname or full domain (e.g. "github.com") to import cookies for. */
    domain: z.ZodString;
}, "strip", z.ZodTypeAny, {
    domain: string;
    type: "import-cookies";
}, {
    domain: string;
    type: "import-cookies";
}>, z.ZodObject<{
    type: z.ZodLiteral<"autofill-credentials">;
    /** CSS selector of the username/email input field to focus first. */
    usernameSelector: z.ZodOptional<z.ZodString>;
    /** If true, dispatch Enter after Chrome fills the form. */
    submitAfterFill: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "autofill-credentials";
    submitAfterFill?: boolean | undefined;
    usernameSelector?: string | undefined;
}, {
    type: "autofill-credentials";
    submitAfterFill?: boolean | undefined;
    usernameSelector?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"extension-hitl-respond">;
    /** Gate UUID issued by HITLSurfaceCoordinator. */
    gateId: z.ZodString;
    /** true = user approved the action; false = user dismissed/denied. */
    accept: z.ZodBoolean;
    /** Optional free-text prompt response (prompt-type gates only). */
    promptText: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "extension-hitl-respond";
    accept: boolean;
    gateId: string;
    promptText?: string | undefined;
}, {
    type: "extension-hitl-respond";
    accept: boolean;
    gateId: string;
    promptText?: string | undefined;
}>]>;
export type BrowserActionInput = z.infer<typeof BrowserActionSchema>;
//# sourceMappingURL=BrowserActionSchema.d.ts.map