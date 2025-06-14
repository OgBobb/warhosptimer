// ==UserScript==
// @name         warhosptimer
// @namespace    https://torn.com/
// @version      3.3
// @description  Hospital timer sorter (runs only on war/rank view)
// @match        https://www.torn.com/factions.php*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/OgBobb/warhosptimer/main/warhosptimer.js
// @updateURL    https://raw.githubusercontent.com/OgBobb/warhosptimer/main/warhosptimer.js
// ==/UserScript==

(function () {
    'use strict';

    const debug = true;
    const log = (...args) => debug && console.log('[warhosptimer]', ...args);

    let activeTimers = {};
    let previousMembers = [];
    let apiKey = localStorage.getItem("warhosptimerKey") || "";
    let lastSort = 0;
    let cooldownUntil = 0;
    let lastContainerId = null;
    let reloadObserver = null;

    if (!apiKey) {
        apiKey = prompt("Enter your Torn API key for warhosptimer:");
        if (apiKey) localStorage.setItem("warhosptimerKey", apiKey);
        else {
            alert("No API key provided. Script halted.");
            return;
        }
    }

    function isOnWarRank() {
        return window.location.hash.includes("#/war/rank");
    }

    function waitForElement(selector) {
        return new Promise(resolve => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    function getFactionIdFromSidebarImage() {
        const img = document.querySelector("img.left");
        if (!img) return null;
        const parts = img.src.split("m/");
        if (parts.length < 2) return null;
        return parts[1].split("-")[0];
    }

    async function fetchFactionMembers(factionId) {
        const now = Date.now();
        if (now < cooldownUntil) {
            log("In cooldown, skipping API fetch.");
            return null;
        }
        try {
            const res = await fetch(`https://api.torn.com/faction/${factionId}?selections=&key=${apiKey}`);
            if (!res.ok) {
                if (res.status === 429) {
                    cooldownUntil = now + 5 * 60 * 1000;
                    log("Rate limited: cooling down 5m.");
                }
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            return data.members;
        } catch (e) {
            cooldownUntil = now + 5 * 60 * 1000;
            console.error("[warhosptimer] Fetch error:", e);
            return null;
        }
    }

    function extractStatusList(membersObj) {
        if (!membersObj || typeof membersObj !== 'object') return [];
        return Object.entries(membersObj).map(([mid, mdata]) => ({ memberId: mid, status: mdata.status }));
    }

    function filterChangedMembers(current) {
        if (!previousMembers.length) return current;
        return current.filter(m => !previousMembers.some(pm => pm.memberId === m.memberId && pm.status.state === m.status.state && pm.status.until === m.status.until));
    }

    function updateDOM(members) {
        const container = document.querySelector("div[class*='members-cont']");
        if (!container || !Array.isArray(members)) return;
        members.forEach(member => {
            const anchor = container.querySelector(`a[href='/profiles.php?XID=${member.memberId}']`);
            if (!anchor) return;
            const statusEl = anchor.closest("li").querySelector(".status.left");
            if (!statusEl) return;
            const state = member.status.state;
            if (state === "Hospital") {
                const updateTimer = () => {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const rem = member.status.until - nowSec;
                    if (rem <= 0) {
                        clearInterval(activeTimers[member.memberId]);
                        delete activeTimers[member.memberId];
                        statusEl.innerText = "Ready";
                        statusEl.style.color = "#66FF66";
                        return;
                    }
                    const h = String(Math.floor(rem / 3600)).padStart(2, '0');
                    const m = String(Math.floor((rem % 3600) / 60)).padStart(2, '0');
                    const s = String(rem % 60).padStart(2, '0');
                    statusEl.innerText = `${h}:${m}:${s}`;
                    statusEl.setAttribute("data-hosp-sort", rem);
                    statusEl.style.color = "#FF6666";
                };
                updateTimer();
                activeTimers[member.memberId] = setInterval(updateTimer, 1000);
            } else if (state === "Traveling") {
                const rem = member.status.until - Math.floor(Date.now() / 1000);
                statusEl.innerText = formatTravel(member.status.description);
                statusEl.setAttribute("data-hosp-sort", rem);
                statusEl.style.color = "#5AC8FA";
            } else if (state === "Abroad") {
                const rem = member.status.until - Math.floor(Date.now() / 1000);
                statusEl.innerText = formatAbroad(member.status.description);
                statusEl.setAttribute("data-hosp-sort", rem);
                statusEl.style.color = "#5AC8FA";
            } else {
                clearInterval(activeTimers[member.memberId]);
                delete activeTimers[member.memberId];
                statusEl.innerText = "Okay";
                statusEl.setAttribute("data-hosp-sort", "-1");
                statusEl.style.color = "#66FF66";
            }
        });
    }

    function formatAbroad(loc) {
        const map = { "In Cayman Islands": "in Caymans", "In United Kingdom": "in UK", "In United Arab Emirates": "in UAE", "In South Africa": "in SA", "In Switzerland": "in Swiss" };
        return map[loc] || loc.replace("In", "in");
    }
    function formatTravel(desc) {
        if (desc.includes("Returning ")) return "to Torn";
        const dest = desc.substring(10);
        const map = { "to Cayman Islands": "to Caymans", "to United Kingdom": "to UK", "to United Arab Emirates": "to UAE", "to South Africa": "to SA", "to Switzerland": "to Swiss" };
        return map[dest] || dest;
    }

    function sortByHospitalTime() {
        const container = document.querySelector("div[class*='members-cont']");
        if (!container) return;
        const rows = Array.from(container.querySelectorAll("ul.members-list > li")).map(li => {
            const statusEl = li.querySelector(".status.left");
            const txt = statusEl?.textContent.trim() || "";
            const val = parseInt(statusEl?.getAttribute("data-hosp-sort") || "999999");
            let cat = 4;
            if (txt === "Okay" || txt === "Ready") cat = 0;
            else if (/^\d{2}:\d{2}:\d{2}$/.test(txt)) cat = 1;
            else if (txt.startsWith("to")) cat = 2;
            else if (txt.startsWith("in")) cat = 3;
            return { li, category: cat, weight: val };
        });
        rows.sort((a,b) => {
            if (a.category !== b.category) return a.category - b.category;
            if (a.category === 1 || a.category === 2) return a.weight - b.weight;
            return 0;
        });
        rows.forEach(r => r.li.parentElement.appendChild(r.li));
        log(`Sorted ${rows.length} members`);
    }

    async function updateLoop(fid) {
        const membersRaw = await fetchFactionMembers(fid);
        if (!membersRaw) return;
        const list = extractStatusList(membersRaw);
        const changed = filterChangedMembers(list);
        previousMembers = list;
        updateDOM(changed);
        sortByHospitalTime();
    }

    function repeatEnforceSort(fid) {
        const now = Date.now();
        if (now - lastSort >= 5000) {
            lastSort = now;
            updateLoop(fid);
        }
        setTimeout(() => repeatEnforceSort(fid), 1000);
    }

    async function init() {
        if (!isOnWarRank()) return;
        Object.values(activeTimers).forEach(id => clearInterval(id));
        activeTimers = {};
        previousMembers = [];
        lastContainerId = null;

        const container = document.querySelector("div[class*='members-cont']");
        if (!container) return;
        lastContainerId = container.innerHTML.length;
        log("Initializing warhosptimer...");
        const fid = getFactionIdFromSidebarImage();
        if (!fid) return log("No faction ID.");
        await updateLoop(fid);
        repeatEnforceSort(fid);
    }

    function observeReload() {
        const root = document.querySelector("#mainContainer, #react-root, body");
        if (!root) return;
        reloadObserver = new MutationObserver(() => {
            if (!isOnWarRank()) return;
            const container = document.querySelector("div[class*='members-cont']");
            const cid = container?.innerHTML.length || 0;
            if (cid !== lastContainerId) init();
        });
        reloadObserver.observe(root, { childList: true, subtree: true });
    }

    waitForElement("div[class*='members-cont']").then(() => {
        if (isOnWarRank()) init();
        window.addEventListener('hashchange', () => {
            if (isOnWarRank()) init();
        });
        observeReload();
    });
})();
