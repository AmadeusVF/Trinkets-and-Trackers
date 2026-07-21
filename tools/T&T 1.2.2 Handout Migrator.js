/**
 * =========================================================
 * @File        T&T 1.2.2 Handout Migrator.js
 * @Description Temporary Roll20 API helper to migrate old T&T 1.2.2 handouts
 *              into the modern T&T Portable Database handout.
 * @Author      AmadeusVF / Codex
 * @Version     0.1.0
 * =========================================================
 *
 * Usage:
 *   !tntMigrate help
 *   !tntMigrate preview
 *   !tntMigrate run
 *
 * Defaults:
 *   Old item handout: T&T Items Catalog
 *   Old shop handout: T&T Shops Catalog
 *   Portable handout: T&T Portable Database
 *
 * Safe behavior:
 *   - Creates a backup handout before writing.
 *   - Adds missing old items into customItems.
 *   - Merges shop item rows as name/price/priceType/stock only.
 *   - Exports all live T&T state shops into portable shops.
 *   - Does not delete anything from handouts or state.
 */
const TnT122HandoutMigrator = (() => {
    'use strict';

    const META = Object.freeze({
        NAME: 'T&T 1.2.2 Handout Migrator',
        CHAT_NAME: 'T&T Migrator',
        VERSION: '0.1.0',
        STATE_KEY: 'TRINKETS_AND_TRACKERS',
        COMMAND: '!tntMigrate',
        OLD_ITEMS_HANDOUT: 'T&T Items Catalog',
        OLD_SHOPS_HANDOUT: 'T&T Shops Catalog',
        PORTABLE_HANDOUT: 'T&T Portable Database',
        SHOP_INFINITE_STOCK: 999999
    });

    const DEFAULT_ITEM = Object.freeze({
        id: '',
        blueprint: 'none',
        name: '',
        displayName: '',
        description: '',
        quantity: 0,
        weight: 0,
        AC: '',
        modifier: '',
        debuff: '',
        requirement: '',
        type: '',
        subtype: '',
        rarity: '',
        defaultPrice: 0,
        defaultPriceType: 'gp',
        imageUrl: '',
        effect: '',
        diceCount: 0,
        diceSide: 0,
        diceSize: 0,
        bonus: 0,
        rollBonus: 0,
        area: '',
        damage: '',
        damageType: '',
        properties: '',
        mastery: '',
        tags: '',
        equippable: false,
        equipped: false,
        attunement: false,
        attuned: false,
        attunementPrerequisite: '',
        consumable: false,
        usable: false,
        useTarget: false,
        useRange: '',
        consumableRange: '',
        questItem: false,
        attunedSet: '-',
        attunedModifier: '',
        attunedValue: ''
    });

    const Utils = {
        escapeHtml(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        stripHtml(value = '') {
            return String(value || '')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
                .replace(/<li[^>]*>/gi, '- ')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;|&apos;/gi, '\'')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&amp;/gi, '&')
                .trim();
        },

        isPlainObject(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value) &&
                Object.prototype.toString.call(value) === '[object Object]';
        },

        sanitizeData(value, depth = 0) {
            if (depth > 80) throw new Error('Data nesting limit exceeded.');
            if (Array.isArray(value)) return value.map((entry) => this.sanitizeData(entry, depth + 1));
            if (!this.isPlainObject(value)) return value;
            const out = {};
            Object.keys(value).forEach((key) => {
                if (['__proto__', 'prototype', 'constructor'].indexOf(key) >= 0) return;
                out[key] = this.sanitizeData(value[key], depth + 1);
            });
            return out;
        },

        safeJsonParse(value, fallback = null) {
            try {
                return this.sanitizeData(JSON.parse(String(value || '')));
            } catch (_error) {
                return fallback;
            }
        },

        parseHandoutJson(raw) {
            const source = this.stripHtml(raw);
            if (!source) return null;
            const candidates = [source];
            const firstBrace = source.indexOf('{');
            const lastBrace = source.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1).trim());
            const firstBracket = source.indexOf('[');
            const lastBracket = source.lastIndexOf(']');
            if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(source.slice(firstBracket, lastBracket + 1).trim());

            for (let i = 0; i < candidates.length; i += 1) {
                const candidate = candidates[i];
                const direct = this.safeJsonParse(candidate, null);
                if (direct !== null) return direct;
                const relaxed = this.safeJsonParse(candidate.replace(/,\s*([}\]])/g, '$1'), null);
                if (relaxed !== null) return relaxed;
            }
            return null;
        },

        toArray(value) {
            if (Array.isArray(value)) return value;
            if (this.isPlainObject(value)) return Object.keys(value).map((key) => value[key]);
            return [];
        },

        parseNumber(value, fallback = 0) {
            if (value === undefined || value === null || value === '') return fallback;
            const number = Number(value);
            return Number.isFinite(number) ? number : fallback;
        },

        toBoolean(value, fallback = false) {
            if (value === undefined || value === null || String(value).trim() === '') return fallback;
            if (value === true || value === false) return value;
            const text = String(value).trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].indexOf(text) >= 0) return true;
            if (['0', 'false', 'no', 'n', 'off'].indexOf(text) >= 0) return false;
            return fallback;
        },

        normalizeName(value) {
            return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
        },

        normalizeId(value) {
            const normalized = String(value || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, '-')
                .replace(/^-+|-+$/g, '');
            return ['__proto__', 'prototype', 'constructor'].indexOf(normalized) >= 0 ? '' : normalized;
        },

        normalizeCurrency(value) {
            const text = String(value || '').trim().toLowerCase();
            return ['cp', 'sp', 'gp'].indexOf(text) >= 0 ? text : 'gp';
        },

        clone(value) {
            return this.sanitizeData(JSON.parse(JSON.stringify(value === undefined ? null : value)));
        },

        nowStamp() {
            const date = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
                pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
        }
    };

    const Chat = {
        whisper(who, title, body) {
            const safeWho = String(who || 'gm').replace(/\s+\(GM\)$/i, '');
            const html =
                '<div style="border:1px solid #777;border-radius:6px;background:#111;color:#eee;padding:8px;line-height:1.35;">' +
                    '<div style="font-weight:700;color:#facc15;border-bottom:1px solid #555;margin-bottom:6px;padding-bottom:4px;">' +
                        Utils.escapeHtml(title) +
                    '</div>' +
                    '<div>' + body + '</div>' +
                '</div>';
            sendChat(META.CHAT_NAME, '/w "' + safeWho + '" ' + html);
        },

        help(who) {
            this.whisper(
                who,
                META.NAME,
                [
                    '<b>Commands</b>',
                    '<code>!tntMigrate preview</code> - dry run, writes nothing.',
                    '<code>!tntMigrate run</code> - merge old handouts and state shops into portable database.',
                    '<br><b>Defaults</b>',
                    'Reads <b>' + Utils.escapeHtml(META.OLD_ITEMS_HANDOUT) + '</b> and <b>' + Utils.escapeHtml(META.OLD_SHOPS_HANDOUT) + '</b>.',
                    'Writes <b>' + Utils.escapeHtml(META.PORTABLE_HANDOUT) + '</b> after creating a backup.',
                    '<br><b>Options</b>',
                    '<code>--overwrite-items</code> updates matching item fields from the old item catalog.',
                    '<code>--overwrite-shops</code> updates matching shop item price/stock.',
                    '<code>--no-shop-items</code> avoids adding missing shop items into customItems.',
                    '<code>--pretty</code> writes formatted JSON.'
                ].join('<br>')
            );
        }
    };

    const Handouts = {
        get(name) {
            const exact = (findObjs({ type: 'handout', name }) || [])[0];
            if (exact) return exact;
            const key = String(name || '').trim().toLowerCase();
            return (findObjs({ type: 'handout' }) || []).filter((handout) => {
                return String(handout.get('name') || '').trim().toLowerCase() === key;
            })[0] || null;
        },

        ensure(name) {
            return this.get(name) || createObj('handout', { name });
        },

        read(name, options = {}) {
            const handout = options.createIfMissing ? this.ensure(name) : this.get(name);
            return new Promise((resolve, reject) => {
                if (!handout) {
                    resolve({ handout: null, raw: '', parsed: null });
                    return;
                }
                try {
                    handout.get('notes', (notes) => {
                        const raw = String(notes || '');
                        resolve({ handout, raw, parsed: Utils.parseHandoutJson(raw) });
                    });
                } catch (error) {
                    reject(error);
                }
            });
        },

        write(name, payload, options = {}) {
            const handout = this.ensure(name);
            const json = JSON.stringify(payload, null, options.pretty ? 2 : 0);
            handout.set('notes', '<div>' + Utils.escapeHtml(json) + '</div>');
            return { handout, json };
        },

        writeRaw(name, raw) {
            const handout = this.ensure(name);
            handout.set('notes', String(raw || ''));
            return handout;
        }
    };

    const Database = {
        defaults() {
            return {
                version: '1.3.7',
                items: [],
                customItems: [],
                shops: [],
                effects: [],
                customTemplates: [],
                tokenDefaults: {},
                settings: {}
            };
        },

        prepare(payload) {
            const base = Utils.isPlainObject(payload) ? Utils.clone(payload) : {};
            const defaults = this.defaults();
            const next = Object.assign({}, defaults, base);
            next.version = String(next.version || defaults.version);
            next.items = Utils.toArray(next.items);
            next.customItems = Utils.toArray(next.customItems || next['Custom Items']);
            next.shops = Utils.toArray(next.shops);
            next.effects = Utils.toArray(next.effects);
            next.customTemplates = Utils.toArray(next.customTemplates || next.templates);
            next.tokenDefaults = Utils.isPlainObject(next.tokenDefaults) ? next.tokenDefaults : {};
            next.settings = Utils.isPlainObject(next.settings) ? next.settings : {};
            delete next['Custom Items'];
            delete next.templates;
            delete next.config;
            return next;
        },

        nextId(portable) {
            const used = Utils.toArray(portable.items).concat(Utils.toArray(portable.customItems))
                .map((item) => String((item && item.id) || '').trim())
                .filter(Boolean);
            let max = -1;
            used.forEach((id) => {
                if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
            });
            if (max >= 0) return String(max + 1).padStart(4, '0');
            return 'custom-' + Date.now().toString(36);
        },

        findItemIndex(list, name) {
            const key = Utils.normalizeName(name);
            return Utils.toArray(list).findIndex((item) => Utils.normalizeName(item && item.name) === key);
        },

        addOrUpdateItem(portable, item, options, stats, source) {
            const defaultIndex = this.findItemIndex(portable.items, item.name);
            const customIndex = this.findItemIndex(portable.customItems, item.name);

            if (defaultIndex >= 0) {
                if (options.overwriteItems && source === 'catalog') {
                    portable.items[defaultIndex] = Object.assign({}, portable.items[defaultIndex], item, {
                        id: portable.items[defaultIndex].id || item.id,
                        blueprint: portable.items[defaultIndex].blueprint || item.blueprint || 'none'
                    });
                    stats.itemsUpdated += 1;
                } else {
                    stats.itemsSkipped += 1;
                }
                return;
            }

            if (customIndex >= 0) {
                if (options.overwriteItems && source === 'catalog') {
                    portable.customItems[customIndex] = Object.assign({}, portable.customItems[customIndex], item, {
                        id: portable.customItems[customIndex].id || item.id,
                        blueprint: portable.customItems[customIndex].blueprint || item.blueprint || 'none'
                    });
                    stats.customItemsUpdated += 1;
                } else {
                    stats.itemsSkipped += 1;
                }
                return;
            }

            item.id = item.id || this.nextId(portable);
            portable.customItems.push(item);
            stats.customItemsAdded += 1;
        },

        findShopIndex(shops, incoming) {
            const idKey = Utils.normalizeId(incoming && (incoming.id || incoming.name));
            const nameKey = Utils.normalizeName(incoming && incoming.name);
            return Utils.toArray(shops).findIndex((shop) => {
                const shopId = Utils.normalizeId(shop && (shop.id || shop.name));
                return (idKey && shopId === idKey) || Utils.normalizeName(shop && shop.name) === nameKey;
            });
        },

        mergeShopItems(existingItems, incomingItems, overwrite, stats) {
            const next = Utils.toArray(existingItems).map((item) => Converters.shopItem(item)).filter(Boolean);
            Utils.toArray(incomingItems).forEach((incoming) => {
                const index = this.findItemIndex(next, incoming && incoming.name);
                if (index >= 0) {
                    if (overwrite) {
                        next[index] = Object.assign({}, next[index], incoming);
                        stats.shopItemsUpdated += 1;
                    } else {
                        stats.shopItemsSkipped += 1;
                    }
                } else {
                    next.push(incoming);
                    stats.shopItemsAdded += 1;
                }
            });
            return next;
        },

        mergeShop(portable, incomingShop, options, stats) {
            if (!incomingShop || !incomingShop.id) return;
            const existingIndex = this.findShopIndex(portable.shops, incomingShop);
            if (existingIndex >= 0) {
                const existing = portable.shops[existingIndex] || {};
                portable.shops[existingIndex] = Object.assign({}, existing, {
                    id: existing.id || incomingShop.id,
                    name: existing.name || incomingShop.name,
                    icon: existing.icon || incomingShop.icon || '&#127978;',
                    state: existing.state || incomingShop.state || 'close',
                    hidden: Utils.toBoolean(existing.hidden, Utils.toBoolean(incomingShop.hidden, false)),
                    config: Object.assign({ hidePrice: false, hasStock: true }, incomingShop.config || {}, existing.config || {}),
                    blacklist: Utils.toArray(existing.blacklist).length ? existing.blacklist : Utils.toArray(incomingShop.blacklist),
                    location: Utils.toArray(existing.location).length ? existing.location : Utils.toArray(incomingShop.location),
                    salesLedger: Utils.toArray(existing.salesLedger).length ? existing.salesLedger : Utils.toArray(incomingShop.salesLedger),
                    earnings: Object.assign({ cp: 0, sp: 0, gp: 0 }, incomingShop.earnings || {}, existing.earnings || {}),
                    createdAt: existing.createdAt || incomingShop.createdAt || Date.now(),
                    updatedAt: Date.now(),
                    itemList: this.mergeShopItems(existing.itemList, incomingShop.itemList, options.overwriteShops, stats)
                });
                stats.shopsUpdated += 1;
                return;
            }

            portable.shops.push(incomingShop);
            stats.shopsAdded += 1;
            stats.shopItemsAdded += Utils.toArray(incomingShop.itemList).length;
        }
    };

    const Converters = {
        blueprint(item) {
            const blueprint = String((item && item.blueprint) || '').trim();
            if (blueprint) return blueprint;
            const templateId = String((item && (item.templateId || item.templateID)) || '').trim();
            if (/^in handout$/i.test(templateId)) return 'In Handout';
            return 'none';
        },

        oldItem(item, id) {
            if (!item || typeof item !== 'object') return null;
            const converted = Object.assign({}, DEFAULT_ITEM, Utils.clone(item));
            delete converted.templateId;
            delete converted.templateID;
            delete converted.abbreviation;
            delete converted.price;
            delete converted.priceType;
            delete converted.stock;
            delete converted.hidden;

            converted.id = String(converted.id || id || '').trim();
            converted.blueprint = this.blueprint(item);
            converted.name = String(converted.name || '').trim();
            converted.displayName = String(item.displayName || item.abbreviation || item.name || converted.name).trim();
            converted.quantity = 0;
            converted.defaultPrice = Utils.parseNumber(converted.defaultPrice, 0);
            converted.defaultPriceType = Utils.normalizeCurrency(converted.defaultPriceType);
            converted.weight = Utils.parseNumber(converted.weight, 0);
            converted.diceCount = Utils.parseNumber(converted.diceCount, 0);
            converted.diceSide = Utils.parseNumber(converted.diceSide || converted.diceSize, 0);
            converted.diceSize = Utils.parseNumber(converted.diceSize || converted.diceSide, converted.diceSide || 0);
            converted.bonus = Utils.parseNumber(converted.bonus, 0);
            converted.rollBonus = Utils.parseNumber(converted.rollBonus || converted.RollBonus, 0);
            converted.equipped = false;
            converted.attuned = false;
            converted.attunned = false;
            converted.equippable = Utils.toBoolean(converted.equippable || converted.Equippable, false);
            converted.attunement = Utils.toBoolean(converted.attunement, false);
            converted.consumable = Utils.toBoolean(converted.consumable, false);
            converted.usable = Utils.toBoolean(converted.usable, false);
            converted.useTarget = Utils.toBoolean(converted.useTarget, false);
            converted.questItem = Utils.toBoolean(converted.questItem, false);
            converted.useRange = String(converted.useRange || converted.consumableRange || '').trim();
            converted.consumableRange = converted.useRange;
            converted.attunedSet = converted.attunedSet || '-';
            converted.attunedModifier = converted.attunedModifier || '';
            converted.attunedValue = converted.attunedValue || '';
            if (!converted.name) return null;
            return converted;
        },

        shopItem(item) {
            const name = String((item && (item.name || item.recordName)) || '').trim();
            if (!name) return null;
            return {
                name,
                price: Utils.parseNumber(item && item.price, Utils.parseNumber(item && item.defaultPrice, 0)),
                priceType: Utils.normalizeCurrency((item && (item.priceType || item.defaultPriceType)) || 'gp'),
                stock: Math.max(0, Utils.parseNumber(item && item.stock, Utils.parseNumber(item && item.quantity, META.SHOP_INFINITE_STOCK)))
            };
        },

        shop(shop) {
            if (!shop || typeof shop !== 'object') return null;
            const now = Date.now();
            const sourceItems = Utils.toArray(shop.itemList || shop.items);
            const id = Utils.normalizeId(shop.id || shop.name || ('shop-' + now));
            if (!id) return null;
            return {
                id,
                name: String(shop.name || id).trim(),
                icon: String(shop.icon || '&#127978;').trim() || '&#127978;',
                itemList: sourceItems.map((item) => this.shopItem(item)).filter(Boolean),
                state: this.shopState(shop.state),
                hidden: Utils.toBoolean(shop.hidden, String(shop.state || '').trim().toLowerCase() === 'hidden'),
                config: Object.assign({ hidePrice: false, hasStock: true }, shop.config || {}),
                blacklist: Utils.toArray(shop.blacklist),
                location: Utils.toArray(shop.location),
                salesLedger: Utils.toArray(shop.salesLedger || shop.itemsSold),
                earnings: Object.assign({ cp: 0, sp: 0, gp: 0 }, shop.earnings || {}),
                createdAt: Utils.parseNumber(shop.createdAt, now),
                updatedAt: now
            };
        },

        shopState(value) {
            const state = String(value || '').trim().toLowerCase();
            if (state === 'open') return 'open';
            return 'close';
        },

        itemListFromLegacy(data) {
            if (!data) return [];
            if (Array.isArray(data)) return data;
            if (Array.isArray(data.items)) return data.items;
            if (Array.isArray(data.customItems)) return data.customItems;
            return Utils.toArray(data);
        },

        shopListFromLegacy(data) {
            if (!data) return [];
            if (Array.isArray(data)) return data;
            if (Array.isArray(data.shops)) return data.shops;
            return Utils.toArray(data).filter((entry) => entry && (entry.itemList || entry.items || entry.name || entry.id));
        },

        shopListFromState() {
            const root = state && state[META.STATE_KEY];
            if (!root || typeof root !== 'object') return [];
            return Utils.toArray(root.shops).filter((shop) => shop && (shop.itemList || shop.items || shop.name || shop.id));
        }
    };

    const Migrator = {
        parseOptions(args) {
            const text = ' ' + (args || []).join(' ') + ' ';
            return {
                overwriteItems: /\s--overwrite-items\s/i.test(text),
                overwriteShops: /\s--overwrite-shops\s/i.test(text),
                importShopItems: !/\s--no-shop-items\s/i.test(text),
                pretty: /\s--pretty\s/i.test(text)
            };
        },

        emptyStats() {
            return {
                catalogItemsRead: 0,
                legacyShopsRead: 0,
                stateShopsRead: 0,
                customItemsAdded: 0,
                itemsUpdated: 0,
                customItemsUpdated: 0,
                itemsSkipped: 0,
                shopsAdded: 0,
                shopsUpdated: 0,
                shopItemsAdded: 0,
                shopItemsUpdated: 0,
                shopItemsSkipped: 0,
                backupCreated: ''
            };
        },

        async collect() {
            const portableRead = await Handouts.read(META.PORTABLE_HANDOUT, { createIfMissing: true });
            const oldItemsRead = await Handouts.read(META.OLD_ITEMS_HANDOUT);
            const oldShopsRead = await Handouts.read(META.OLD_SHOPS_HANDOUT);
            return {
                portableRead,
                oldItems: Converters.itemListFromLegacy(oldItemsRead.parsed),
                oldShops: Converters.shopListFromLegacy(oldShopsRead.parsed),
                stateShops: Converters.shopListFromState()
            };
        },

        merge(collected, options) {
            const portable = Database.prepare(collected.portableRead.parsed);
            const stats = this.emptyStats();

            Utils.toArray(collected.oldItems).forEach((rawItem) => {
                const converted = Converters.oldItem(rawItem, Database.nextId(portable));
                if (!converted) return;
                stats.catalogItemsRead += 1;
                Database.addOrUpdateItem(portable, converted, options, stats, 'catalog');
            });

            Utils.toArray(collected.oldShops).forEach((rawShop) => {
                const incoming = Converters.shop(rawShop);
                if (!incoming) return;
                stats.legacyShopsRead += 1;
                Database.mergeShop(portable, incoming, options, stats);
                if (options.importShopItems) {
                    Utils.toArray(rawShop.itemList || rawShop.items).forEach((shopItem) => {
                        const convertedItem = Converters.oldItem(shopItem, Database.nextId(portable));
                        if (convertedItem) Database.addOrUpdateItem(portable, convertedItem, Object.assign({}, options, { overwriteItems: false }), stats, 'shop');
                    });
                }
            });

            Utils.toArray(collected.stateShops).forEach((rawShop) => {
                const incoming = Converters.shop(rawShop);
                if (!incoming) return;
                stats.stateShopsRead += 1;
                Database.mergeShop(portable, incoming, options, stats);
            });

            return { portable, stats };
        },

        async run(mode, msg, args) {
            const isPreview = mode !== 'run';
            const options = this.parseOptions(args);
            const collected = await this.collect();
            const result = this.merge(collected, options);

            if (!isPreview) {
                const backupName = META.PORTABLE_HANDOUT + ' Backup ' + Utils.nowStamp();
                Handouts.writeRaw(backupName, collected.portableRead.raw || '<div>{}</div>');
                result.stats.backupCreated = backupName;
                Handouts.write(META.PORTABLE_HANDOUT, result.portable, { pretty: options.pretty });
            }

            Chat.whisper(msg.who, isPreview ? 'T&T Migration Preview' : 'T&T Migration Complete', this.renderStats(result.stats, result.portable, isPreview));
        },

        renderStats(stats, portable, preview) {
            const rows = [
                '<b>Mode:</b> ' + (preview ? 'Preview only, nothing was written.' : 'Run complete, portable database was written.'),
                stats.backupCreated ? '<b>Backup:</b> ' + Utils.escapeHtml(stats.backupCreated) : '',
                '<hr style="border:0;border-top:1px solid #555;">',
                '<b>Old catalog items read:</b> ' + stats.catalogItemsRead,
                '<b>Old shops read:</b> ' + stats.legacyShopsRead,
                '<b>State shops exported:</b> ' + stats.stateShopsRead,
                '<b>Custom items added:</b> ' + stats.customItemsAdded,
                '<b>Items updated:</b> ' + (stats.itemsUpdated + stats.customItemsUpdated),
                '<b>Items skipped:</b> ' + stats.itemsSkipped,
                '<b>Shops added:</b> ' + stats.shopsAdded,
                '<b>Shops updated:</b> ' + stats.shopsUpdated,
                '<b>Shop items added:</b> ' + stats.shopItemsAdded,
                '<b>Shop items updated:</b> ' + stats.shopItemsUpdated,
                '<b>Shop items skipped:</b> ' + stats.shopItemsSkipped,
                '<hr style="border:0;border-top:1px solid #555;">',
                '<b>Final counts:</b> items=' + Utils.toArray(portable.items).length +
                    ', customItems=' + Utils.toArray(portable.customItems).length +
                    ', shops=' + Utils.toArray(portable.shops).length
            ].filter(Boolean);
            return rows.join('<br>');
        }
    };

    const handleChat = (msg) => {
        if (!msg || msg.type !== 'api') return;
        const parts = String(msg.content || '').trim().split(/\s+/);
        if (parts[0] !== META.COMMAND) return;

        if (!playerIsGM(msg.playerid)) {
            Chat.whisper(msg.who, META.NAME, 'Only a GM can run this migration.');
            return;
        }

        const action = String(parts[1] || 'help').toLowerCase();
        if (action === 'help') {
            Chat.help(msg.who);
            return;
        }

        if (action !== 'preview' && action !== 'run') {
            Chat.help(msg.who);
            return;
        }

        Migrator.run(action, msg, parts.slice(2)).catch((error) => {
            Chat.whisper(msg.who, 'T&T Migration Failed', '<pre style="white-space:pre-wrap;color:#ffd2d2;">' + Utils.escapeHtml(error && (error.stack || error.message) || String(error)) + '</pre>');
        });
    };

    on('chat:message', handleChat);

    on('ready', () => {
        log(META.NAME + ' v' + META.VERSION + ' ready. Use ' + META.COMMAND + ' help.');
    });

    return { Migrator, Utils };
})();
