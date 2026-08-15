/*
 * ============================================================================
 *  TURN MARKER COUNTER — Roll20 Mod API
 * ============================================================================
 *  Developer: AmadeusVF
 *  Version: 1.0.0
 *
 *  WHAT IT DOES
 *
 *   - Counts down numbered token status markers when the turn tracker moves
 *     forward.
 *   - Example: snail@3 becomes snail@2, then snail@1, then removed.
 *   - Reduction can happen when a token starts its turn or when a token ends
 *     its turn.
 *   - Backward turn tracker movement is ignored.
 *   - The GM can undo the latest reported reduction from the chat card.
 *
 *  COMMANDS
 *
 *   !tmc menu
 *     Opens the configuration menu.
 *
 *   !tmc toggle enabled
 *     Turns all script automation on or off.
 *
 *   !tmc toggle timing
 *     Switches marker reduction between START and END timing.
 *
 *   !tmc toggle info
 *     Shows or hides the marker reduction report cards.
 *
 *   !tmc toggle public
 *     Sends marker reduction report cards to public chat instead of the GM.
 *
 *   !tmc background <url>
 *     Changes the card background image URL.
 *
 *   !tmc reset-background
 *     Restores the default card background image.
 *
 *   !tmc undo <key>
 *     Internal button command that restores the markers reduced by one report.
 *
 *  SETTINGS
 *
 *   Script Enable
 *     OFF disables all reading and marker reduction.
 *
 *   Reduce Timing when turn
 *     START reduces the token that just started its turn.
 *     END reduces the token that just finished its turn.
 *
 *   Show Reduction Info
 *     OFF keeps reducing counters but hides the explanatory reduction card.
 *
 *   Public Reduction Report
 *     ON sends reduction cards to public chat. OFF whispers them to the GM.
 *
 *   Background Image URL
 *     Controls the card background image.
 * ============================================================================
 */

(function () {
    "use strict";

    const SCRIPT_INFO = Object.freeze({
        name: "Turn Marker Counter",
        developer: "AmadeusVF",
        developerURL: "https://www.patreon.com/cw/AmadeusVF/home",
        version: "1.0.0",
    });

    const COMMANDS = Object.freeze(["!tmc", "!turnMarkerCounter"]);
    const UNDO_TTL_MS = 10 * 60 * 1000;

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        reduceOnTurnBegin: true,
        reduceTiming: "start",
        showInformation: true,
        publicReductionReport: false,
        backgroundImageUrl: "https://images.rawpixel.com/image_800/cHJpdmF0ZS9sci9pbWFnZXMvd2Vic2l0ZS8yMDIzLTEyL3Jhd3BpeGVsX29mZmljZV80Nl9ibGFja193YWxscGFwZXJfbW9ub2Nocm9tZV9jaGluZXNlX2RyYWdvbl8yNmY3MzllOS1mYzkwLTQ3MDEtYjdmNS01NjFmMTQwMjc1OGRfMS5qcGc.jpg"
    });

    const CARD_STYLE = Object.freeze({
        speaker: SCRIPT_INFO.name,
        titleColor: "#f5e6b8",
        bodyColor: "#f2f2f2",
        borderColor: "#8f6f2a",
        titleBgColor: "rgba(47, 35, 18, 0.35)",
        titleLineColor: "rgba(245, 205, 96, 0.8)",
        bodyBgColor: "rgba(18, 18, 18, 0.92)",
        bgOverlayStart: "rgba(0, 0, 0, 0.8)",
        bgOverlayEnd: "rgba(0, 0, 0, 0.8)",
        bgSize: "auto 100%",
        bgPosition: "right 25px bottom 100px"
    });

    const BUTTON_STYLE = Object.freeze({
        width: 32,
        height: 15,
        onColor: "rgba(35,135,65,0.95)",
        offColor: "rgba(145,35,35,0.95)",
        editColor: "rgba(60,85,145,0.95)",
        borderColor: "rgb(127, 127, 127)",
        textColor: "#f2f2f2"
    });

    on("ready", function () {
        ensureState();
        sendStartupCard();
    });

    on("chat:message", function (message) {
        handleCommand(message);
    });

    on("change:campaign:turnorder", function (campaign, prev) {
        const settings = getSettings();

        if (!settings.enabled) {
            return;
        }

        const newTurnOrder = parseTurnOrder(campaign.get("turnorder"));
        const oldTurnOrder = parseTurnOrder(prev && prev.turnorder);

        if (newTurnOrder.length === 0) {
            return;
        }

        const newTurn = newTurnOrder[0];
        const oldTurn = oldTurnOrder[0];

        if (!isForwardTurn(oldTurnOrder, newTurnOrder)) {
            return;
        }

        const targetTurn = getReduceTiming() === "end" ? oldTurn : newTurn;

        if (!targetTurn || targetTurn.id === "-1") {
            return;
        }

        const token = getObj("graphic", targetTurn.id);

        if (!token) {
            return;
        }

        reduceTokenMarkers(token);
    });

    function ensureState() {
        state.TurnMarkerCounter = state.TurnMarkerCounter || {};
        state.TurnMarkerCounter.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            state.TurnMarkerCounter.settings || {}
        );
        if (state.TurnMarkerCounter.settings.reduceTiming !== "start" &&
            state.TurnMarkerCounter.settings.reduceTiming !== "end") {
            state.TurnMarkerCounter.settings.reduceTiming =
                state.TurnMarkerCounter.settings.reduceOnTurnBegin === false ? "end" : "start";
        }
        state.TurnMarkerCounter.undoActions = state.TurnMarkerCounter.undoActions || {};
        cleanupUndoActions();
    }

    function getSettings() {
        ensureState();
        return state.TurnMarkerCounter.settings;
    }

    function getUndoActions() {
        ensureState();
        return state.TurnMarkerCounter.undoActions;
    }

    function getReduceTiming() {
        const timing = String(getSettings().reduceTiming || "start").toLowerCase();
        return timing === "end" ? "end" : "start";
    }

    function parseTurnOrder(turnorder) {
        if (!turnorder || turnorder === "") {
            return [];
        }

        try {
            return JSON.parse(turnorder);
        } catch (e) {
            return [];
        }
    }

    function tokenize(content) {
        return String(content || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
    }

    function stripQuotes(value) {
        const text = String(value || "").trim();
        if ((text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
            (text.charAt(0) === "'" && text.charAt(text.length - 1) === "'")) {
            return text.slice(1, -1);
        }
        return text;
    }

    function isCommandRoot(root) {
        const normalized = String(root || "").toLowerCase();
        return normalized === "!tmc" || normalized === "!turnmarkercounter";
    }

    function isGm(playerId) {
        return typeof playerIsGM === "function" && playerIsGM(playerId);
    }

    function handleCommand(message) {
        if (!message || message.type !== "api") {
            return;
        }

        const simpleParts = String(message.content || "").trim().split(/\s+/);
        const tokens = tokenize(message.content);
        const root = simpleParts[0] || tokens[0];

        if (!isCommandRoot(root)) {
            return;
        }

        if (!isGm(message.playerid)) {
            whisperCardToGm(
                SCRIPT_INFO.name,
                '<div style="color:#f2c36b;">Only the GM can configure this script.</div>'
            );
            return;
        }

        const action = String(simpleParts[1] || tokens[1] || "menu").toLowerCase();
        const setting = String(simpleParts[2] || tokens[2] || "").toLowerCase();

        if (action === "undo") {
            undoMarkerReduction(tokens[2]);
            return;
        }

        if (action === "toggle" && setting === "enabled") {
            toggleSetting("enabled");
            sendSettingsMenu();
            return;
        }

        if (action === "toggle" && (setting === "timing" || setting === "reduce")) {
            toggleReduceTiming();
            sendSettingsMenu();
            return;
        }

        if (action === "toggle" && setting === "info") {
            toggleSetting("showInformation");
            sendSettingsMenu();
            return;
        }

        if (action === "toggle" && setting === "public") {
            toggleSetting("publicReductionReport");
            sendSettingsMenu();
            return;
        }

        if (action === "background") {
            const rawUrl = stripQuotes(tokens.slice(2).join(" "));
            if (rawUrl) {
                getSettings().backgroundImageUrl = rawUrl;
            }
            sendSettingsMenu();
            return;
        }

        if (action === "reset-background") {
            getSettings().backgroundImageUrl = DEFAULT_SETTINGS.backgroundImageUrl;
            sendSettingsMenu();
            return;
        }

        sendSettingsMenu();
    }

    function cleanupUndoActions() {
        const now = Date.now();
        const actions = state.TurnMarkerCounter && state.TurnMarkerCounter.undoActions || {};

        Object.keys(actions).forEach(function (key) {
            if (!actions[key] || actions[key].expiresAt <= now) {
                delete actions[key];
            }
        });
    }

    function createUndoAction(token, tokenName, changes) {
        const key = String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
        const actions = getUndoActions();

        actions[key] = {
            tokenId: getTokenId(token),
            tokenName: tokenName,
            changes: changes,
            expiresAt: Date.now() + UNDO_TTL_MS
        };

        return key;
    }

    function getTokenId(token) {
        if (!token) {
            return "";
        }

        return String(token.id || token.get("_id") || "");
    }

    function isForwardTurn(oldTurnOrder, newTurnOrder) {
        if (!oldTurnOrder.length || !newTurnOrder.length || oldTurnOrder.length < 2) {
            return false;
        }

        const oldActiveId = String(oldTurnOrder[0] && oldTurnOrder[0].id || "");
        const newActiveId = String(newTurnOrder[0] && newTurnOrder[0].id || "");

        if (!oldActiveId || !newActiveId || oldActiveId === newActiveId || newActiveId === "-1") {
            return false;
        }

        const nextIndex = 1 % oldTurnOrder.length;
        const expectedNextId = String(oldTurnOrder[nextIndex] && oldTurnOrder[nextIndex].id || "");

        return newActiveId === expectedNextId;
    }

    function undoMarkerReduction(key) {
        const actionKey = String(key || "").trim();
        const actions = getUndoActions();
        const entry = actions[actionKey];

        if (!entry || entry.expiresAt <= Date.now()) {
            delete actions[actionKey];
            whisperCardToGm(
                SCRIPT_INFO.name,
                '<div style="color:#f2c36b;">This undo action has expired.</div>'
            );
            return;
        }

        const token = getObj("graphic", entry.tokenId);

        if (!token) {
            delete actions[actionKey];
            whisperCardToGm(
                SCRIPT_INFO.name,
                '<div style="color:#f2c36b;">The token for this undo action was not found.</div>'
            );
            return;
        }

        const markers = String(token.get("statusmarkers") || "")
            .split(",")
            .filter(Boolean);
        const restored = [];

        (entry.changes || []).forEach(function (change) {
            const rawName = String(change.rawMarkerName || "");
            const afterValue = parseInt(change.value, 10);
            let restoredValue = afterValue + 1;
            let restoredExisting = false;

            for (let index = 0; index < markers.length; index += 1) {
                const match = markers[index].match(/^(.*)@(\d+)$/);
                if (!match || match[1] !== rawName || parseInt(match[2], 10) !== afterValue) {
                    continue;
                }

                restoredValue = parseInt(match[2], 10) + 1;
                markers[index] = rawName + "@" + restoredValue;
                restoredExisting = true;
                break;
            }

            if (!restoredExisting) {
                markers.push(rawName + "@" + restoredValue);
            }

            restored.push({
                markerName: change.markerName || formatMarkerName(rawName.split("::")[0]),
                value: restoredValue
            });
        });

        token.set("statusmarkers", markers.join(","));
        delete actions[actionKey];
        sendUndoReport(token.get("name") || entry.tokenName || "Unnamed Token", restored);
    }

    function toggleSetting(key) {
        const settings = getSettings();
        settings[key] = !settings[key];
    }

    function toggleReduceTiming() {
        const settings = getSettings();
        const currentTiming = String(settings.reduceTiming || "start").toLowerCase() === "end" ? "end" : "start";
        settings.reduceTiming = currentTiming === "start" ? "end" : "start";
        settings.reduceOnTurnBegin = settings.reduceTiming === "start";
    }

    function sendStartupCard() {
        const body =
            '<div style="text-align:center;">' +
                '<div style="text-align:center;margin:0;">' +
                    button("Config", COMMANDS[0] + " menu", {
                        width: 54,
                        backgroundColor: BUTTON_STYLE.editColor
                    }) +
                '</div>' +
            '</div>';

        whisperCardToGm(SCRIPT_INFO.name, body);
    }

    function developerLink() {
        return '<a href="' + escapeHtml(SCRIPT_INFO.developerURL) + '" target="_blank" style="' +
            'color:rgb(0,180,180);text-decoration:none;font-weight:700;' +
        '"><b>' + escapeHtml(SCRIPT_INFO.developer) + '</b></a>';
    }

    function sendSettingsMenu() {
        const settings = getSettings();
        const backgroundCommand = COMMANDS[0] + " background ?{Background Image URL|" +
            escapeCommandValue(settings.backgroundImageUrl || DEFAULT_SETTINGS.backgroundImageUrl) + "}";
        const body =
            settingsSection("Settings",
                settingRow(
                    "Script Enable",
                    toggleButton(settings.enabled, COMMANDS[0] + " toggle enabled")
                ) +
                settingRow(
                    "Reduce Timing when turn",
                    timingButton(getReduceTiming(), COMMANDS[0] + " toggle timing")
                ) +
                settingRow(
                    "Show Reduction Info",
                    toggleButton(settings.showInformation, COMMANDS[0] + " toggle info")
                ) +
                settingRow(
                    "Public Reduction Report",
                    toggleButton(settings.publicReductionReport, COMMANDS[0] + " toggle public")
                ) +
                settingRow(
                    "Background Image URL",
                    button("Edit", backgroundCommand, {
                        backgroundColor: BUTTON_STYLE.editColor
                    })
                )
            ) +
            '<div style="margin-top:6px;text-align:center;">' +
                button("Reset BG", COMMANDS[0] + " reset-background", {
                    width: 62,
                    backgroundColor: BUTTON_STYLE.offColor
                }) +
            '</div>' +
            settingsFooter();

        whisperCardToGm(SCRIPT_INFO.name, body);
    }

    function settingsFooter() {
        return '<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:6px;"><tbody><tr>' +
            '<td style="text-align:left;vertical-align:middle;font-size:10px;line-height:14px;color:#d8d8d8;">' +
                '<b>Developer:</b> ' + developerLink() +
            '</td>' +
            '<td style="text-align:right;vertical-align:middle;font-size:10px;line-height:14px;color:#d8d8d8;">' +
                '<b>Version:</b> ' + escapeHtml(SCRIPT_INFO.version) +
            '</td>' +
        '</tr></tbody></table>';
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function escapeCommandValue(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/[|}]/g, "");
    }

    function safeCssUrl(value) {
        const text = String(value || "").trim();
        if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(text)) {
            return "";
        }
        return text.replace(/'/g, "%27");
    }

    function formatMarkerName(markerName) {
        return String(markerName || "")
            .replace(/[-_]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\b[a-z]/g, function (letter) {
                return letter.toUpperCase();
            });
    }

    function tmcCard(title, body) {
        const settings = getSettings();
        const bgImageUrl = safeCssUrl(settings.backgroundImageUrl) ||
            safeCssUrl(DEFAULT_SETTINGS.backgroundImageUrl);
        const backgroundImage = bgImageUrl
            ? "background-image:linear-gradient(" + CARD_STYLE.bgOverlayStart + "," +
                CARD_STYLE.bgOverlayEnd + "),url('" + bgImageUrl + "');"
            : "background:" + CARD_STYLE.bodyBgColor + ";";

        return (
            '<div data-turn-marker-counter-card="1" style="display:block;width:100%;text-align:left;box-sizing:border-box;">' +
                '<div style="' +
                    'display:block;width:260px;max-width:100%;' +
                    backgroundImage +
                    'background-size:' + CARD_STYLE.bgSize + ';' +
                    'background-position:' + CARD_STYLE.bgPosition + ';' +
                    'background-repeat:no-repeat;' +
                    'background-attachment:fixed;' +
                    'border:1px solid ' + CARD_STYLE.borderColor + ';' +
                    'border-radius:8px;overflow:hidden;box-sizing:border-box;' +
                    'font-family:Arial,Helvetica,sans-serif;' +
                '">' +
                    '<div style="' +
                        'padding:8px 12px;text-align:center;font-weight:700;font-size:18px;' +
                        'color:' + CARD_STYLE.titleColor + ';background:' + CARD_STYLE.titleBgColor + ';' +
                    '">' +
                        escapeHtml(title || SCRIPT_INFO.name) +
                        '<div style="height:1px;background:' + CARD_STYLE.titleLineColor + ';margin:6px -6px -8px -6px;"></div>' +
                    '</div>' +
                    '<div style="' +
                        'padding:8px 10px 10px 10px;text-align:center;line-height:18px;' +
                        'color:' + CARD_STYLE.bodyColor + ';background:transparent;' +
                        'overflow-wrap:anywhere;' +
                    '">' +
                        body +
                    '</div>' +
                '</div>' +
            '</div>'
        );
    }

    function whisperCardToGm(title, body) {
        sendChat(
            CARD_STYLE.speaker,
            "/w gm " + tmcCard(title, body)
        );
    }

    function publicCard(title, body) {
        sendChat(
            CARD_STYLE.speaker,
            tmcCard(title, body)
        );
    }

    function sendReductionCard(title, body) {
        if (getSettings().publicReductionReport) {
            publicCard(title, body);
            return;
        }

        whisperCardToGm(title, body);
    }

    function button(label, command, options) {
        const buildOptions = options || {};
        const width = Number(buildOptions.width || BUTTON_STYLE.width);
        const height = Number(buildOptions.height || BUTTON_STYLE.height);
        const backgroundColor = buildOptions.backgroundColor || "rgba(0, 0, 0, 0.62)";
        const text = String(label || "");

        return '<a href="' + escapeHtml(command || "#") + '" style="' +
            'display:inline-block;' +
            'width:' + width + 'px;' +
            'height:' + height + 'px;' +
            'min-width:' + width + 'px;' +
            'padding:0;margin:0;' +
            'color:' + BUTTON_STYLE.textColor + ';' +
            'font-size:10px;font-weight:900;line-height:' + height + 'px;' +
            'text-align:center;text-decoration:none;text-transform:uppercase;' +
            'white-space:nowrap;overflow:hidden;vertical-align:middle;' +
            'background-color:' + backgroundColor + ';' +
            'border:1px solid ' + BUTTON_STYLE.borderColor + ';' +
            'border-radius:4px;box-sizing:border-box;cursor:pointer;' +
        '">' + escapeHtml(text) + '</a>';
    }

    function toggleButton(isOn, command) {
        return button(isOn ? "ON" : "OFF", command, {
            backgroundColor: isOn ? BUTTON_STYLE.onColor : BUTTON_STYLE.offColor
        });
    }

    function timingButton(timing, command) {
        const isStart = timing !== "end";
        return button(isStart ? "START" : "END", command, {
            backgroundColor: isStart ? BUTTON_STYLE.onColor : BUTTON_STYLE.editColor
        });
    }

    function settingRow(label, controlHtml) {
        return '<tr>' +
            '<td style="padding:1px 6px 1px 0;text-align:left;vertical-align:middle;font-size:12px;line-height:14px;">' +
                escapeHtml(label) +
            '</td>' +
            '<td style="padding:1px 0 1px 6px;text-align:right;vertical-align:middle;width:66px;line-height:14px;">' +
                String(controlHtml || "") +
            '</td>' +
        '</tr>';
    }

    function settingsSection(title, rowsHtml) {
        return '<div style="margin:0 0 4px 0;text-align:left;">' +
            '<div style="margin:0 0 2px 0;padding:0 0 2px 0;text-align:center;border-bottom:2px solid rgba(255,255,255,0.18);font-size:12px;font-weight:700;color:#f5e6b8;">' +
                escapeHtml(title) +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><tbody>' +
                String(rowsHtml || "") +
            '</tbody></table>' +
        '</div>';
    }

    function reduceTokenMarkers(token) {
        const markerString = token.get("statusmarkers");

        if (!markerString) {
            return;
        }

        const tokenName = token.get("name") || "Unnamed Token";
        const markers = markerString.split(",");
        const newMarkers = [];
        const changes = [];

        markers.forEach(function (marker) {
            const match = marker.match(/^(.*)@(\d+)$/);

            if (!match) {
                newMarkers.push(marker);
                return;
            }

            const markerName = match[1];
            const value = parseInt(match[2], 10);
            const displayMarkerName = formatMarkerName(markerName.split("::")[0]);

            if (value <= 1) {
                changes.push({
                    rawMarkerName: markerName,
                    markerName: displayMarkerName,
                    value: 0
                });
                return;
            }

            const newValue = value - 1;
            newMarkers.push(markerName + "@" + newValue);
            changes.push({
                rawMarkerName: markerName,
                markerName: displayMarkerName,
                value: newValue
            });
        });

        token.set("statusmarkers", newMarkers.join(","));

        if (changes.length > 0 && getSettings().showInformation) {
            sendMarkerReport(token, tokenName, changes);
        }
    }

    function markerRows(changes) {
        const rows = (changes || []).map(function (change) {
            return '<tr>' +
                '<td style="padding:1px 6px 1px 0;text-align:left;vertical-align:middle;font-size:12px;line-height:18px;color:#f2f2f2;font-weight:700;overflow-wrap:anywhere;">' +
                    escapeHtml(change.markerName) +
                '</td>' +
                '<td style="padding:1px 0 1px 6px;text-align:right;vertical-align:middle;width:54px;font-size:12px;line-height:18px;color:#f5e6b8;font-weight:700;white-space:nowrap;">' +
                    '&rarr; ' + escapeHtml(change.value) +
                '</td>' +
            '</tr>';
        }).join("");

        return '<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><tbody>' +
            rows +
        '</tbody></table>';
    }

    function sendMarkerReport(token, tokenName, changes) {
        const undoKey = createUndoAction(token, tokenName, changes);
        const rows = markerRows(changes) +
            '<div style="margin-top:8px;text-align:center;">' +
                button("Undo", COMMANDS[0] + " undo " + undoKey, {
                    width: 48,
                    backgroundColor: BUTTON_STYLE.editColor
                }) +
            '</div>';

        sendReductionCard(tokenName, rows);
    }

    function sendUndoReport(tokenName, changes) {
        const rows = '<div style="margin-bottom:4px;color:#d8d8d8;font-size:12px;">Counters restored.</div>' +
            markerRows(changes);

        whisperCardToGm(tokenName, rows);
    }
}());
