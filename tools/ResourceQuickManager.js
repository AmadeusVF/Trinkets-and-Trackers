/*
 * Resource Quick Manager
 * Roll20 2024 character sheet helper.
 *
 * Commands (player access disabled by default, selected token required):
 *   !resource scan
 *   !resource get Resource Name
 *   !resource set Resource Name 3
 *   !resource add Resource Name 1
 *   !resource use Resource Name 1
 *   !resource getpublic Resource Name
 *   !resource setpublic Resource Name 3
 *   !resource addpublic Resource Name 1
 *   !resource usepublic Resource Name 1
 * GM-only whisper commands (GM + token/character controller):
 *   !resource getwhisper Resource Name
 *   !resource setwhisper Resource Name 3
 *   !resource addwhisper Resource Name 1
 *   !resource usewhisper Resource Name 1
 *   !resource players true/false   (GM only; resets to false on sandbox restart)
 *
 * Add [characterId] after the action to target a character directly:
 *   !resource usepublic [-CharacterId] Resource Name 1
 */

const ResourceQuickManager = (() => {
    'use strict';

    const META = Object.freeze({
        NAME: 'Resource Quick Manager',
        VERSION: '1.4.5',
        COMMAND: '!resource',
        DEVELOPER: 'AmadeusVF'
    });

    const CONFIG = Object.freeze({
        MAX_STORE_BYTES: 9500000,
        SHEET_WORKER_TIMEOUT_MS: 2500,
        CHAT_SPEAKER: 'Resource Quick Manager',
        CARD_BACKGROUND_URL: 'https://images.rawpixel.com/image_800/cHJpdmF0ZS9sci9pbWFnZXMvd2Vic2l0ZS8yMDIzLTEyL3Jhd3BpeGVsX29mZmljZV80Nl9ibGFja193YWxscGFwZXJfbW9ub2Nocm9tZV9jaGluZXNlX2RyYWdvbl8yNmY3MzllOS1mYzkwLTQ3MDEtYjdmNS01NjFmMTQwMjc1OGRfMS5qcGc.jpg',
        TOKEN_COLOR: 'rgb(211, 194, 12)',
        VALUE_COLOR: 'rgb(52, 203, 116)',
        RESOURCE_COLOR: 'rgb(232, 220, 180)'
    });

    const locks = Object.create(null);

    // Runtime-only permission. Intentionally not stored in Roll20 state.
    // Every API sandbox restart returns player command access to false.
    const Access = {
        playersEnabled: false,

        setPlayersEnabled(value) {
            this.playersEnabled = value === true;
            return this.playersEnabled;
        }
    };

    const Logger = {
        info(...args) {
            log('[' + META.NAME + '] ' + args.map(String).join(' '));
        },

        error(...args) {
            log('[' + META.NAME + ':ERROR] ' + args.map((value) => {
                if (value && value.stack) return value.stack;
                return String(value);
            }).join(' '));
        }
    };

    const Utils = {
        isObject(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value);
        },

        hasOwn(object, key) {
            return Object.prototype.hasOwnProperty.call(object || {}, key);
        },

        normalizeName(value = '') {
            return String(value || '')
                .trim()
                .replace(/\s+/g, ' ')
                .toLowerCase();
        },

        cleanName(value = '') {
            const text = String(value || '').trim();
            if (text.length >= 2) {
                const first = text.charAt(0);
                const last = text.charAt(text.length - 1);
                if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                    return text.slice(1, -1).trim();
                }
            }
            return text;
        },

        toFiniteNumber(value) {
            if (value === null || value === undefined || value === '') return null;
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
        },

        toNonNegativeInteger(value) {
            const number = this.toFiniteNumber(value);
            if (number === null || number < 0 || Math.floor(number) !== number) return null;
            return number;
        },

        clamp(value, min, max) {
            return Math.min(max, Math.max(min, value));
        },

        deepClone(value) {
            if (value === null || value === undefined) return value;
            return JSON.parse(JSON.stringify(value));
        },

        parseObject(value) {
            if (this.isObject(value)) {
                try {
                    return this.deepClone(value);
                } catch (error) {
                    return null;
                }
            }
            if (typeof value !== 'string' || !value.trim()) return null;
            try {
                const parsed = JSON.parse(value);
                return this.isObject(parsed) ? parsed : null;
            } catch (error) {
                return null;
            }
        },

        utf8ByteLength(value = '') {
            const text = String(value || '');
            let bytes = 0;
            for (let i = 0; i < text.length; i += 1) {
                const code = text.charCodeAt(i);
                if (code < 0x80) bytes += 1;
                else if (code < 0x800) bytes += 2;
                else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
                    const next = text.charCodeAt(i + 1);
                    if (next >= 0xDC00 && next <= 0xDFFF) {
                        bytes += 4;
                        i += 1;
                    } else bytes += 3;
                } else bytes += 3;
            }
            return bytes;
        },

        escapeHtml(value = '') {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        formatNumber(value) {
            const number = this.toFiniteNumber(value);
            if (number === null) return '?';
            return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
        },

        formatResourceValue(value) {
            const number = this.toFiniteNumber(value);
            if (number !== null) return this.formatNumber(number);
            const text = String(value === undefined || value === null ? '' : value).trim();
            return text || '?';
        }
    };

    const WriteQueue = {
        async withCharacter(characterId = '', operation = null) {
            const key = 'character:' + String(characterId || '').trim();
            if (typeof operation !== 'function') return undefined;

            const previous = locks[key] || Promise.resolve();
            const run = previous
                .catch(() => undefined)
                .then(() => operation());
            const guarded = run.catch(() => undefined);
            locks[key] = guarded;

            try {
                return await run;
            } finally {
                if (locks[key] === guarded) delete locks[key];
            }
        },

        diagnostics() {
            return Object.keys(locks);
        }
    };

    const Render = {
        card(title = '', body = '', type = 'normal', options = {}) {
            const colors = {
                normal: { border: '#60646c', title: '#d7d9df' },
                success: { border: '#267a48', title: '#75d59a' },
                warning: { border: '#8b6a1e', title: '#f0c85b' },
                error: { border: '#8a3030', title: '#ef8c8c' }
            };
            const palette = colors[type] || colors.normal;
            const backgroundImage = 'linear-gradient(rgba(0,0,0,0.8),rgba(0,0,0,0.8)),url(\'' + CONFIG.CARD_BACKGROUND_URL + '\')';
            const iconUrl = String(options.iconUrl || '').trim();
            const titleHtml = Utils.escapeHtml(title).replace(/\r?\n/g, '<br>');
            const titleIcon = iconUrl
                ? '<img src="' + Utils.escapeHtml(iconUrl) + '" style="display:block;width:30px;height:30px;min-width:25px;object-fit:cover;margin:0;" />'
                : '';
            return '<div style="display:block;width:calc(100% + 30px);margin-left:-30px;text-align:left;box-sizing:border-box;">' +
                '<div style="display:block;width:300px;max-width:100%;background-image:' + backgroundImage + ';background-size:auto 100%;background-position:right 25px bottom 100px;background-repeat:no-repeat;background-attachment:fixed;border:1px solid ' + palette.border + ';border-radius:8px;overflow:hidden;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;">' +
                    '<div style="padding:8px 12px;text-align:left;font-weight:700;font-size:14px;color:' + palette.title + ';background:rgba(0,0,0,0.6);">' +
                        '<table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0;margin:0;padding:0;">' +
                            '<tr>' +
                                '<td style="width:15%;height:25px;padding:0;vertical-align:middle;text-align:left;">' + titleIcon + '</td>' +
                                '<td style="width:70%;padding:0;vertical-align:middle;text-align:center;white-space:normal;overflow-wrap:anywhere;word-break:break-word;">' + titleHtml + '</td>' +
                                '<td style="width:15%;padding:0;vertical-align:middle;" aria-hidden="true"></td>' +
                            '</tr>' +
                        '</table>' +
                        '<div style="height:1px;background:rgba(215,47,47,0.8);margin:6px -6px -8px -6px;"></div>' +
                    '</div>' +
                    '<div style="padding:8px 10px 10px 10px;text-align:center;color:rgb(255,255,255);background:rgba(0,0,0,0.3);font-size:14px;line-height:1.45;">' + body + '</div>' +
                '</div>' +
            '</div>';
        },

        row(label = '', value = '', valueColor = '#f0c85b') {
            return '<div style="border-bottom:1px solid #292b30;padding:3px 0;">' +
                '<span style="color:#8ebfe8;font-weight:700;">' + Utils.escapeHtml(label) + ':</span> ' +
                '<span style="color:' + valueColor + ';font-weight:700;">' + Utils.escapeHtml(value) + '</span>' +
            '</div>';
        },

        send(title = '', body = '', type = 'normal', options = {}) {
            sendChat(CONFIG.CHAT_SPEAKER, '/w gm ' + this.card(title, body, type, options), null, { noarchive: true });
        },

        sendPublic(title = '', body = '', iconUrl = '') {
            sendChat(CONFIG.CHAT_SPEAKER, this.card(title, body, 'normal', { iconUrl }));
        },

        playerDisplayName(playerId = '') {
            const safePlayerId = String(playerId || '').trim();
            if (!safePlayerId) return '';
            const player = getObj('player', safePlayerId);
            if (!player) return '';
            return String(player.get('_displayname') || player.get('displayname') || '').trim();
        },

        sendToPlayer(playerId = '', title = '', body = '', type = 'normal', options = {}) {
            const displayName = this.playerDisplayName(playerId);
            if (!displayName) return false;
            const safeWhisperName = displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            sendChat(
                CONFIG.CHAT_SPEAKER,
                '/w "' + safeWhisperName + '" ' + this.card(title, body, type, options),
                null,
                { noarchive: true }
            );
            return true;
        },

        sendToActor(actor = {}, title = '', body = '', type = 'normal', options = {}) {
            if (actor && actor.isGM === false && actor.playerId) {
                return this.sendToPlayer(actor.playerId, title, body, type, options);
            }
            this.send(title, body, type, options);
            return true;
        },

        sendPlayerAndGM(playerId = '', title = '', body = '', type = 'normal', options = {}) {
            this.send(title, body, type, options);
            this.sendToPlayer(playerId, title, body, type, options);
        },

        whisperTargets(ctx = {}) {
            const ids = Object.create(null);
            const addControllers = (value = '') => {
                String(value || '').split(',').map((id) => id.trim()).filter(Boolean).forEach((id) => {
                    if (id === 'all') {
                        (findObjs({ _type: 'player' }) || []).forEach((player) => {
                            const playerId = String(player.id || player.get('_id') || '').trim();
                            if (playerId && (typeof playerIsGM !== 'function' || !playerIsGM(playerId))) ids[playerId] = true;
                        });
                        return;
                    }
                    if (typeof playerIsGM === 'function' && playerIsGM(id)) return;
                    ids[id] = true;
                });
            };

            if (!ctx.direct && ctx.token && typeof ctx.token.get === 'function') {
                addControllers(ctx.token.get('controlledby'));
            }
            if (!Object.keys(ids).length && ctx.character && typeof ctx.character.get === 'function') {
                addControllers(ctx.character.get('controlledby'));
            }

            return Object.keys(ids).map((playerId) => {
                const player = getObj('player', playerId);
                if (!player) return '';
                return String(player.get('_displayname') || player.get('displayname') || '').trim();
            }).filter(Boolean);
        },

        sendWhisper(title = '', body = '', type = 'normal', options = {}, ctx = {}) {
            const card = this.card(title, body, type, options);
            sendChat(CONFIG.CHAT_SPEAKER, '/w gm ' + card, null, { noarchive: true });

            const sent = Object.create(null);
            this.whisperTargets(ctx).forEach((displayName) => {
                const key = String(displayName || '').toLowerCase();
                if (!key || sent[key]) return;
                sent[key] = true;
                const safeWhisperName = String(displayName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                sendChat(CONFIG.CHAT_SPEAKER, '/w "' + safeWhisperName + '" ' + card, null, { noarchive: true });
            });
        },

        help(message = '', actor = {}) {
            let body = (message
                ? '<div style="color:#ef8c8c;margin-bottom:7px;">' + Utils.escapeHtml(message) + '</div>'
                : '') +
                '<div style="color:#b8bbc2;">Select one linked token, then use:</div>' +
                '<div style="color:#f0c85b;margin-top:5px;">!resource scan</div>' +
                '<div style="color:#f0c85b;">!resource get Resource Name</div>' +
                '<div style="color:#f0c85b;">!resource set Resource Name 3</div>' +
                '<div style="color:#f0c85b;">!resource add Resource Name 1</div>' +
                '<div style="color:#f0c85b;">!resource use Resource Name 1</div>' +
                '<div style="color:#b8bbc2;margin-top:6px;">Public cards:</div>' +
                '<div style="color:#f0c85b;">!resource getpublic Resource Name</div>' +
                '<div style="color:#f0c85b;">!resource setpublic Resource Name 3</div>' +
                '<div style="color:#f0c85b;">!resource addpublic Resource Name 1</div>' +
                '<div style="color:#f0c85b;">!resource usepublic Resource Name 1</div>';

            if (!actor || actor.isGM !== false) {
                body += '<div style="color:#b8bbc2;margin-top:6px;">GM + token controller:</div>' +
                    '<div style="color:#f0c85b;">!resource getwhisper Resource Name</div>' +
                    '<div style="color:#f0c85b;">!resource setwhisper Resource Name 3</div>' +
                    '<div style="color:#f0c85b;">!resource addwhisper Resource Name 1</div>' +
                    '<div style="color:#f0c85b;">!resource usewhisper Resource Name 1</div>' +
                    '<div style="color:#b8bbc2;margin-top:6px;">Player access (GM only, runtime):</div>' +
                    '<div style="color:#f0c85b;">!resource players true</div>' +
                    '<div style="color:#f0c85b;">!resource players false</div>';
            }

            body += '<div style="color:#b8bbc2;margin-top:6px;">Optional direct target:</div>' +
                '<div style="color:#f0c85b;">!resource get [characterId] Resource Name</div>';

            this.sendToActor(actor, META.NAME, body, message ? 'error' : 'normal');
        },

        resourceNarrative(result = {}) {
            const tokenName = String(result.tokenName || result.characterName || 'Token').trim();
            const characterName = String(result.characterName || tokenName || 'Character').trim();
            const resourceName = String(result.resourceName || 'Resource').trim();
            const characterHtml = this.publicSpan(characterName, CONFIG.TOKEN_COLOR);
            const resourceHtml = this.publicSpan(resourceName, CONFIG.RESOURCE_COLOR);
            const afterHtml = this.publicSpan(Utils.formatResourceValue(result.after), CONFIG.VALUE_COLOR);
            let body = '';

            if (result.action === 'use') {
                const used = Math.max(0, (Utils.toFiniteNumber(result.before) || 0) - (Utils.toFiniteNumber(result.after) || 0));
                body = characterHtml + ' uses ' +
                    this.publicSpan(Utils.formatNumber(used), CONFIG.VALUE_COLOR) + ' ' +
                    resourceHtml + ', and has ' + afterHtml + ' left.';
            } else if (result.action === 'add') {
                const recovered = Math.max(0, (Utils.toFiniteNumber(result.after) || 0) - (Utils.toFiniteNumber(result.before) || 0));
                body = characterHtml + ' recovers ' +
                    this.publicSpan(Utils.formatNumber(recovered), CONFIG.VALUE_COLOR) + ' ' +
                    resourceHtml + ', and has ' + afterHtml + ' left.';
            } else {
                body = characterHtml + ' has ' + afterHtml + ' ' + resourceHtml + '.';
            }

            return {
                title: tokenName + '\n' + resourceName,
                body,
                iconUrl: result.tokenImage
            };
        },

        resourceResult(result = {}, ctx = {}, actor = {}) {
            const narrative = this.resourceNarrative(result);
            const options = { iconUrl: narrative.iconUrl };

            if (result.whisperOutput) {
                this.sendWhisper(narrative.title, narrative.body, 'normal', options, ctx);
            } else if (actor && actor.isGM === false && actor.playerId) {
                this.sendPlayerAndGM(actor.playerId, narrative.title, narrative.body, 'normal', options);
            } else {
                this.send(narrative.title, narrative.body, 'normal', options);
            }
        },

        publicSpan(value = '', color = '#ffffff') {
            return '<span style="color:' + color + ';font-weight:700;">' + Utils.escapeHtml(value) + '</span>';
        },

        resourcePublic(result = {}) {
            const narrative = this.resourceNarrative(result);
            this.sendPublic(narrative.title, narrative.body, narrative.iconUrl);
        },

        resourceScan(result = {}, actor = {}) {
            const resources = Array.isArray(result.resources) ? result.resources : [];
            const pageSize = 20;
            const characterName = String(result.characterName || 'Unknown').trim();
            const characterHtml = this.publicSpan(characterName, CONFIG.TOKEN_COLOR);
            const sendScan = (title, body, type) => {
                if (actor && actor.isGM === false && actor.playerId) {
                    this.sendPlayerAndGM(actor.playerId, title, body, type);
                } else {
                    this.send(title, body, type);
                }
            };

            if (!resources.length) {
                sendScan(
                    'Resource Scan',
                    '<div style="text-align:left;">' + characterHtml + ' has:' +
                        '<div style="color:#b8bbc2;padding-top:5px;">No resources were found.</div>' +
                    '</div>',
                    'warning'
                );
                return;
            }

            for (let offset = 0; offset < resources.length; offset += pageSize) {
                const page = resources.slice(offset, offset + pageSize);
                let body = '<div style="text-align:left;">' + characterHtml + ' has:';

                page.forEach((resource) => {
                    const resourceName = this.publicSpan(resource.name || 'Unnamed Resource', CONFIG.RESOURCE_COLOR);
                    const current = this.publicSpan(Utils.formatResourceValue(resource.current), CONFIG.VALUE_COLOR);
                    const maximum = this.publicSpan(Utils.formatResourceValue(resource.max), CONFIG.VALUE_COLOR);
                    body += '<div style="padding-top:3px;">' + resourceName + ' - ' + current +
                        '<span style="color:#ffffff;font-weight:700;">/</span>' + maximum + '</div>';
                });

                body += '</div>';
                const first = offset + 1;
                const last = offset + page.length;
                sendScan(
                    'Resource Scan ' + first + '-' + last + ' / ' + resources.length,
                    body,
                    'normal'
                );
            }
        },

        error(message = '', context = {}, actor = {}) {
            let body = '<div style="color:#efb0b0;">' + Utils.escapeHtml(message || 'Unknown resource error.') + '</div>';
            if (context.characterName) body += this.row('Character', context.characterName, '#d7d9df');
            if (context.resourceName) body += this.row('Resource', context.resourceName, '#f0c85b');
            this.sendToActor(actor, 'Resource Error', body, 'error');
        }
    };

    const Command = {
        extractCharacterTarget(value = '') {
            const source = String(value || '').trim();
            const matches = source.match(/\[[^\]\s]+\]/g) || [];
            if (matches.length > 1) {
                return { ok: false, message: 'Use only one [characterId] target.' };
            }
            if (!matches.length) return { ok: true, characterId: '', args: source };
            const characterId = matches[0].slice(1, -1).trim();
            const args = source.replace(matches[0], ' ').replace(/\s+/g, ' ').trim();
            return characterId
                ? { ok: true, characterId, args }
                : { ok: false, message: 'Character ID cannot be empty.' };
        },

        parse(content = '') {
            const text = String(content || '').trim();
            if (text.toLowerCase() === META.COMMAND) return { ok: false, help: true, message: '' };
            if (text.toLowerCase().indexOf(META.COMMAND + ' ') !== 0) return null;

            const remainder = text.slice(META.COMMAND.length).trim();

            const playersMatch = remainder.match(/^players\b\s*(.*)$/i);
            if (playersMatch) {
                const value = String(playersMatch[1] || '').trim().toLowerCase();
                if (value !== 'true' && value !== 'false') {
                    return {
                        ok: false,
                        help: true,
                        action: 'players',
                        message: 'Players requires true or false.'
                    };
                }
                return {
                    ok: true,
                    action: 'players',
                    enabled: value === 'true',
                    name: '',
                    value: null,
                    publicOutput: false,
                    whisperOutput: false,
                    characterId: ''
                };
            }

            const target = this.extractCharacterTarget(remainder);
            if (!target.ok) return { ok: false, help: true, message: target.message };
            const actionMatch = target.args.match(/^(scan|getpublic|setpublic|addpublic|usepublic|getwhisper|setwhisper|addwhisper|usewhisper|get|set|add|use)\b\s*(.*)$/i);
            if (!actionMatch) {
                return { ok: false, help: true, message: 'Unknown action.' };
            }

            const requestedAction = actionMatch[1].toLowerCase();
            const publicOutput = /public$/.test(requestedAction);
            const whisperOutput = /whisper$/.test(requestedAction);
            const action = requestedAction.replace(/(?:public|whisper)$/, '');
            const args = String(actionMatch[2] || '').trim();
            if (action === 'scan') {
                return args
                    ? { ok: false, help: true, message: 'Scan does not accept a resource name or value.' }
                    : { ok: true, action, name: '', value: null, publicOutput: false, whisperOutput: false, characterId: target.characterId };
            }
            if (!args) {
                return { ok: false, help: true, action, publicOutput, whisperOutput, message: 'Resource name is required.' };
            }

            if (action === 'get') {
                const name = Utils.cleanName(args);
                return name
                    ? { ok: true, action, name, value: null, publicOutput, whisperOutput, characterId: target.characterId }
                    : { ok: false, help: true, action, publicOutput, whisperOutput, message: 'Resource name is required.' };
            }

            const valueMatch = args.match(/^(.*?)\s+([+-]?\d+)\s*$/);
            if (!valueMatch) {
                return { ok: false, help: true, action, publicOutput, whisperOutput, message: 'A non-negative integer value is required.' };
            }

            const name = Utils.cleanName(valueMatch[1]);
            const value = Utils.toNonNegativeInteger(valueMatch[2]);
            if (!name) return { ok: false, help: true, action, publicOutput, whisperOutput, message: 'Resource name is required.' };
            if (value === null) return { ok: false, help: true, action, publicOutput, whisperOutput, message: 'Value must be a non-negative integer.' };

            return { ok: true, action, name, value, publicOutput, whisperOutput, characterId: target.characterId };
        }
    };

    const SheetStore = {
        getStoreAttribute(characterId = '') {
            const safeId = String(characterId || '').trim();
            if (!safeId) return null;
            return (findObjs({
                _type: 'attribute',
                _characterid: safeId,
                name: 'store'
            }) || [])[0] || null;
        },

        async readFresh(characterId = '') {
            const rootAttr = this.getStoreAttribute(characterId);
            if (!rootAttr) {
                return { ok: false, message: 'The selected character has no store attribute.' };
            }

            const attributeCurrent = rootAttr.get('current');
            let rawCurrent = attributeCurrent;
            let root = Utils.parseObject(attributeCurrent);

            if (typeof getSheetItem === 'function') {
                try {
                    const freshValue = await getSheetItem(String(characterId || '').trim(), 'store');
                    const freshRoot = Utils.parseObject(freshValue);
                    if (freshRoot) {
                        rawCurrent = freshValue;
                        root = freshRoot;
                    }
                } catch (error) {
                    Logger.info('Fresh store read failed; using the attribute value.');
                }
            }

            if (!root) {
                return { ok: false, message: 'The character store is not valid JSON.' };
            }

            return {
                ok: true,
                rootAttr,
                root,
                mode: Utils.isObject(rawCurrent) ? 'object' : 'json-string',
                baselineJson: JSON.stringify(root)
            };
        },

        getIntegrants(root = {}) {
            if (!Utils.isObject(root.integrants)) return null;
            const integrants = root.integrants.integrants;
            return Utils.isObject(integrants) ? integrants : null;
        },

        findResources(root = {}, resourceName = '') {
            const integrants = this.getIntegrants(root);
            if (!integrants) return [];
            const wanted = Utils.normalizeName(resourceName);
            if (!wanted) return [];

            return Object.keys(integrants).map((rowId) => {
                const node = integrants[rowId];
                return { rowId, node };
            }).filter((entry) => {
                const node = entry.node;
                if (!Utils.isObject(node)) return false;
                if (String(node.type || '').trim().toLowerCase() !== 'resource') return false;
                return Utils.normalizeName(node.name) === wanted ||
                    Utils.normalizeName(node.recordName) === wanted;
            });
        },

        getResourceMax(node = {}) {
            if (!Utils.isObject(node)) return '?';
            if (Utils.isObject(node.maxValueFormula) && Utils.hasOwn(node.maxValueFormula, 'flatValue')) {
                return Utils.formatResourceValue(node.maxValueFormula.flatValue);
            }
            return '?';
        },

        listResources(root = {}) {
            const integrants = this.getIntegrants(root);
            if (!integrants) return [];
            return Object.keys(integrants).map((rowId) => {
                const node = integrants[rowId];
                if (!Utils.isObject(node)) return null;
                if (String(node.type || '').trim().toLowerCase() !== 'resource') return null;
                return {
                    rowId,
                    name: String(node.name || node.recordName || 'Unnamed Resource').trim(),
                    recordName: String(node.recordName || '').trim(),
                    current: node.value,
                    max: this.getResourceMax(node)
                };
            }).filter(Boolean).sort((left, right) => {
                return String(left.name || '').localeCompare(String(right.name || ''));
            });
        },

        serialize(entry = {}) {
            if (!entry.rootAttr || !Utils.isObject(entry.root)) {
                return { ok: false, message: 'The character store is invalid.' };
            }

            let json = '';
            try {
                json = JSON.stringify(entry.root);
                const parsed = JSON.parse(json);
                if (!Utils.isObject(parsed)) {
                    return { ok: false, message: 'The serialized store did not produce an object.' };
                }
            } catch (error) {
                return { ok: false, message: 'The character store could not be serialized safely.' };
            }

            const byteLength = Utils.utf8ByteLength(json);
            if (byteLength > CONFIG.MAX_STORE_BYTES) {
                return {
                    ok: false,
                    message: 'The character store is too large to write safely (' + byteLength + ' bytes).'
                };
            }

            return {
                ok: true,
                json,
                byteLength,
                value: entry.mode === 'object' ? entry.root : json
            };
        },

        waitForWorker(timeoutMs = CONFIG.SHEET_WORKER_TIMEOUT_MS) {
            if (typeof onSheetWorkerCompleted !== 'function') return Promise.resolve(false);
            return new Promise((resolve) => {
                let finished = false;
                const finish = (value) => {
                    if (finished) return;
                    finished = true;
                    resolve(value);
                };
                try {
                    onSheetWorkerCompleted(() => finish(true));
                    setTimeout(() => finish(false), Math.max(250, Number(timeoutMs) || CONFIG.SHEET_WORKER_TIMEOUT_MS));
                } catch (error) {
                    finish(false);
                }
            });
        },

        verifyResource(rootAttr, rowId = '', resourceName = '', expectedValue = 0) {
            const current = rootAttr ? rootAttr.get('current') : null;
            const root = Utils.parseObject(current);
            const integrants = root ? this.getIntegrants(root) : null;
            if (!integrants) return { ok: false, message: 'The store could not be read after writing.' };

            let node = integrants[rowId];
            if (!Utils.isObject(node) || String(node.type || '').toLowerCase() !== 'resource') {
                const matches = this.findResources(root, resourceName);
                if (matches.length !== 1) {
                    return { ok: false, message: 'The resource could not be verified after writing.' };
                }
                node = matches[0].node;
            }

            const actual = Utils.toFiniteNumber(node.value);
            if (actual === null || actual !== expectedValue) {
                return {
                    ok: false,
                    message: 'The resource write did not match the requested value.',
                    actual
                };
            }
            return { ok: true, actual };
        },

        isBaselineCurrent(entry = {}) {
            if (!entry.rootAttr || !String(entry.baselineJson || '')) return false;
            const currentRoot = Utils.parseObject(entry.rootAttr.get('current'));
            if (!currentRoot) return false;
            try {
                return JSON.stringify(currentRoot) === entry.baselineJson;
            } catch (error) {
                return false;
            }
        },

        async writeResource(entry = {}, rowId = '', resourceName = '', expectedValue = 0) {
            const serialized = this.serialize(entry);
            if (!serialized.ok) return serialized;

            // Do not overwrite a newer store written by T&T or another API script.
            if (!this.isBaselineCurrent(entry)) {
                return {
                    ok: false,
                    message: 'The character sheet changed during this operation. No resource write was made; try again.'
                };
            }

            const attr = entry.rootAttr;
            try {
                if (attr && typeof attr.setWithWorker === 'function') {
                    const workerPromise = this.waitForWorker();
                    attr.setWithWorker({ current: serialized.value });
                    await workerPromise;
                } else if (attr && typeof attr.set === 'function') {
                    attr.set({ current: serialized.value });
                } else {
                    return { ok: false, message: 'The store attribute cannot be written.' };
                }
            } catch (error) {
                Logger.error('Store write failed.', error);
                return { ok: false, message: 'Roll20 rejected the resource write.' };
            }

            const verified = this.verifyResource(attr, rowId, resourceName, expectedValue);
            if (!verified.ok) return verified;
            return { ok: true, actual: verified.actual, bytes: serialized.byteLength };
        }
    };

    const Service = {
        findRepresentativeToken(characterId = '') {
            const safeId = String(characterId || '').trim();
            if (!safeId) return null;
            const strict = findObjs({
                _type: 'graphic',
                _subtype: 'token',
                represents: safeId
            }) || [];
            if (strict.length) return strict[0];
            return (findObjs({ _type: 'graphic', represents: safeId }) || [])[0] || null;
        },

        objectControlledBy(object = null, playerId = '') {
            if (!object || typeof object.get !== 'function') return false;
            const safePlayerId = String(playerId || '').trim();
            if (!safePlayerId) return false;
            return String(object.get('controlledby') || '')
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
                .some((id) => id === 'all' || id === safePlayerId);
        },

        playerControlsContext(ctx = {}, playerId = '') {
            const safePlayerId = String(playerId || '').trim();
            if (!safePlayerId) return false;

            // A direct [characterId] must be controlled through the Character itself.
            // This prevents a representative token elsewhere on the table from granting access.
            if (ctx.direct) return this.objectControlledBy(ctx.character, safePlayerId);

            return this.objectControlledBy(ctx.token, safePlayerId) ||
                this.objectControlledBy(ctx.character, safePlayerId);
        },

        getCharacterContext(msg = {}, directCharacterId = '') {
            const safeDirectId = String(directCharacterId || '').trim();
            if (safeDirectId) {
                const character = getObj('character', safeDirectId);
                if (!character) return { ok: false, message: 'The requested [characterId] was not found.' };
                const token = this.findRepresentativeToken(safeDirectId);
                const characterName = String(character.get('name') || 'Character').trim();
                return {
                    ok: true,
                    token,
                    character,
                    characterId: safeDirectId,
                    characterName,
                    tokenName: String((token && token.get('name')) || characterName || 'Token').trim(),
                    tokenImage: String((token && token.get('imgsrc')) || character.get('avatar') || '').trim(),
                    direct: true
                };
            }

            const selected = Array.isArray(msg.selected)
                ? msg.selected.find((entry) => entry && entry._type === 'graphic' && entry._id)
                : null;
            if (!selected) return { ok: false, message: 'Select one token first.' };

            const token = getObj('graphic', selected._id);
            if (!token) return { ok: false, message: 'The selected token no longer exists.' };
            const characterId = String(token.get('represents') || '').trim();
            if (!characterId) return { ok: false, message: 'The selected token is not linked to a character.' };
            const character = getObj('character', characterId);
            if (!character) return { ok: false, message: 'The linked character could not be found.' };

            return {
                ok: true,
                token,
                character,
                characterId,
                characterName: String(character.get('name') || token.get('name') || 'Character').trim(),
                tokenName: String(token.get('name') || character.get('name') || 'Token').trim(),
                tokenImage: String(token.get('imgsrc') || character.get('avatar') || '').trim(),
                direct: false
            };
        },

        getCurrentValue(resource = {}) {
            const numeric = Utils.toFiniteNumber(resource.value);
            if (numeric !== null) return numeric;
            const text = String(resource.value === undefined || resource.value === null ? '' : resource.value).trim();
            return text || '?';
        },

        calculateNext(action = '', current = 0, requested = 0) {
            const boundedCurrent = Math.max(0, current);
            let desired = boundedCurrent;
            if (action === 'set') desired = requested;
            else if (action === 'add') desired = boundedCurrent + requested;
            else if (action === 'use') desired = boundedCurrent - requested;
            const next = Math.max(0, desired);
            return {
                next,
                clamped: next !== desired || boundedCurrent !== current
            };
        },

        async execute(ctx = {}, command = {}) {
            return WriteQueue.withCharacter(ctx.characterId, async () => {
                const storeEntry = await SheetStore.readFresh(ctx.characterId);
                if (!storeEntry.ok) return storeEntry;

                if (command.action === 'scan') {
                    return {
                        ok: true,
                        action: 'scan',
                        characterId: ctx.characterId,
                        characterName: ctx.characterName,
                        resources: SheetStore.listResources(storeEntry.root)
                    };
                }

                const matches = SheetStore.findResources(storeEntry.root, command.name);
                if (!matches.length) {
                    return {
                        ok: false,
                        message: 'The resource does not exist on the selected character sheet.'
                    };
                }
                if (matches.length > 1) {
                    return {
                        ok: false,
                        message: 'More than one resource has that name. No changes were made.'
                    };
                }

                const match = matches[0];
                const current = this.getCurrentValue(match.node);

                const baseResult = {
                    ok: true,
                    action: command.action,
                    characterId: ctx.characterId,
                    characterName: ctx.characterName,
                    tokenName: ctx.tokenName,
                    tokenImage: ctx.tokenImage,
                    resourceName: String(match.node.name || command.name).trim(),
                    before: current,
                    after: current,
                    requested: command.value,
                    publicOutput: !!command.publicOutput,
                    whisperOutput: !!command.whisperOutput,
                    clamped: false
                };

                if (command.action === 'get') {
                    if (command.publicOutput && Utils.toFiniteNumber(match.node.value) === null) {
                        return {
                            ok: false,
                            message: 'Public resource cards require a numeric resource value.'
                        };
                    }
                    return baseResult;
                }

                const numericCurrent = Utils.toFiniteNumber(match.node.value);
                if (numericCurrent === null) {
                    return {
                        ok: false,
                        message: 'The resource current value is not numeric, so it cannot be changed safely.'
                    };
                }

                if (command.action === 'use' && numericCurrent <= 0) {
                    baseResult.before = 0;
                    baseResult.after = 0;
                    baseResult.empty = true;
                    return baseResult;
                }

                const change = this.calculateNext(command.action, numericCurrent, command.value);
                match.node.value = change.next;
                baseResult.after = change.next;
                baseResult.clamped = change.clamped;

                const writeResult = await SheetStore.writeResource(
                    storeEntry,
                    match.rowId,
                    baseResult.resourceName,
                    change.next
                );
                if (!writeResult.ok) return writeResult;
                baseResult.after = writeResult.actual;
                baseResult.storeBytes = writeResult.bytes;
                return baseResult;
            });
        }
    };

    const Events = {
        async onChatMessage(msg = {}) {
            if (!msg || msg.type !== 'api') return;
            const command = Command.parse(msg.content);
            if (!command) return;

            const playerId = String(msg.playerid || '');
            const isGM = typeof playerIsGM === 'function' && playerIsGM(playerId);
            const actor = { playerId, isGM };

            // The runtime access switch itself is always GM-only.
            if (command.action === 'players') {
                if (!isGM) {
                    Render.error('Only the GM can change player access.', {}, actor);
                    return;
                }
                if (!command.ok) {
                    Render.help(command.message || '', actor);
                    return;
                }
                const enabled = Access.setPlayersEnabled(command.enabled);
                Render.send(
                    'Player Commands',
                    '<div style="text-align:left;">Player access is <span style="color:' +
                        (enabled ? '#75d59a' : '#ef8c8c') + ';font-weight:700;">' +
                        (enabled ? 'ENABLED' : 'DISABLED') + '</span>.</div>',
                    enabled ? 'success' : 'warning'
                );
                Logger.info('Player command access ' + (enabled ? 'enabled.' : 'disabled.'));
                return;
            }

            // Players receive a private explanation instead of being ignored.
            if (!isGM && !Access.playersEnabled) {
                Render.error('Player access is disabled. Ask your DM to enable it.', {}, actor);
                return;
            }

            // *whisper is intentionally GM -> player only.
            if (!isGM && command.whisperOutput) {
                Render.error('Whisper commands are GM only.', {}, actor);
                return;
            }

            if (!command.ok) {
                Render.help(command.message || '', actor);
                return;
            }

            const ctx = Service.getCharacterContext(msg, command.characterId);
            if (!ctx.ok) {
                Render.error(ctx.message || 'A linked token is required.', { resourceName: command.name }, actor);
                return;
            }

            // Player commands remain restricted to characters/tokens they control.
            if (!isGM && !Service.playerControlsContext(ctx, playerId)) {
                Render.error('You do not control the selected token or character.', {
                    characterName: ctx.characterName,
                    resourceName: command.name
                }, actor);
                return;
            }

            try {
                const result = await Service.execute(ctx, command);
                if (!result || !result.ok) {
                    Render.error(
                        (result && result.message) || 'The resource operation failed.',
                        { characterName: ctx.characterName, resourceName: command.name },
                        actor
                    );
                    return;
                }
                if (result.action === 'scan') Render.resourceScan(result, actor);
                else if (result.publicOutput) Render.resourcePublic(result);
                else Render.resourceResult(result, ctx, actor);
            } catch (error) {
                Logger.error('Unhandled command failure.', error);
                Render.error('The resource operation failed before it could complete.', {
                    characterName: ctx.characterName,
                    resourceName: command.name
                }, actor);
            }
        },

        bind() {
            on('chat:message', (msg) => {
                this.onChatMessage(msg).catch((error) => {
                    Logger.error('Chat handler failure.', error);
                    const playerId = String((msg && msg.playerid) || '');
                    const isGM = typeof playerIsGM === 'function' && playerIsGM(playerId);
                    Render.error('Unexpected Resource Quick Manager error.', {}, { playerId, isGM });
                });
            });
        }
    };

    on('ready', () => {
        Events.bind();
        Logger.info('v' + META.VERSION + ' ready.');
    });

    const publicApi = {
        meta: META,
        diagnostics: () => ({ activeLocks: WriteQueue.diagnostics(), playersEnabled: Access.playersEnabled })
    };

    if (typeof globalThis !== 'undefined' && globalThis.__RQM_TEST_MODE__ === true) {
        publicApi.__test = {
            Utils,
            Command,
            SheetStore,
            Service,
            Render,
            WriteQueue,
            Access
        };
    }

    return Object.freeze(publicApi);
})();
