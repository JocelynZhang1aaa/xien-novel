/* 对话转小说 · 单页应用（解锁 + Loading + 简介 + 阅读合一） */
(function () {
  var novel = window.NOVEL;
  if (!novel) return;

  var chapters = novel.chapters || [];
  var total = chapters.length;
  var pay = novel.pay || {};
  // ===== 后台可配置项（默认值，后端可通过 data.js 的 pay 覆盖）=====
  var UNIT           = pay.unit || "电量";
  var CHAPTER_PRICE  = (pay.chapterPrice != null) ? pay.chapterPrice : 200;   // N：单章价，默认 200
  var BUNDLE_DISCOUNT= (pay.bundleDiscount != null) ? pay.bundleDiscount : 0.9; // X：全部解锁折扣，默认 0.9（9 折）
  var CH1_PRICE      = (pay.ch1UnlockPrice != null) ? pay.ch1UnlockPrice : 0;  // 解锁第 1 章电量，默认 0（免费解锁）
  var INITIAL_BALANCE= (pay.initialBalance != null) ? pay.initialBalance : 500;
  // 兼容旧引用
  pay.unit = UNIT; pay.chapterPrice = CHAPTER_PRICE; pay.initialBalance = INITIAL_BALANCE;

  // 对话内容不足时，小说末尾的「下一页」按钮变为「去聊天」，跳转至对应 bot 链接
  var CHAT_BOT_URL = "https://qun.qq.com/qunpro/robot/qunshare?robot_appid=3889846188&robot_uin=102808513";
  var NEEDS_MORE_CHAT = (novel.needsMoreChat !== false);

  // ===== 目录世界分组（仅当 data 配置 chaptersPerWorld > 0 时生效；index.html 不带该配置，不受影响）=====
  var CHAPTERS_PER_WORLD = (novel.chaptersPerWorld != null && novel.chaptersPerWorld > 0) ? novel.chaptersPerWorld : 0;
  var WORLD_NOVEL_TITLES = novel.worldNovelTitles || [];
  var DEFAULT_WORLD_TITLE = novel.defaultWorldTitle || "我偏要和他过不去";
  // 标签是否挪到「第一个世界」分组头下方（默认 false → 标签在书名上方；index_v2 设为 true）
  var TAGS_UNDER_WORLD = (novel.tagsUnderWorld === true);
  // 是否展示标签（默认 true；index_v2 设为 false → 任何位置都不展示标签）
  var SHOW_TAGS = (novel.showTags !== false);
  // 阿拉伯数字 → 中文（支持到 99，足够世界分组使用）
  function cnNum(n) {
    var d = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if (n <= 0) return "";
    if (n < 10) return d[n];
    if (n < 20) return "十" + (n % 10 ? d[n % 10] : "");
    if (n < 100) return d[Math.floor(n / 10)] + "十" + (n % 10 ? d[n % 10] : "");
    return String(n);
  }
  function worldTitleOf(worldIdx) {
    var t = WORLD_NOVEL_TITLES[worldIdx - 1] || DEFAULT_WORLD_TITLE;
    return "第" + cnNum(worldIdx) + "个世界 · " + t;
  }
  function worldOf(idx) { return Math.floor(idx / CHAPTERS_PER_WORLD) + 1; }

  // 简介页是否允许「左滑进入阅读」（默认 true；index_v2 设为 false，仅支持点击章节进入正文）
  var SWIPE_TO_READ = (novel.swipeToRead !== false);

  // 解锁第1章的价格（后台可配置：pay.ch1UnlockPrice，默认 0）
  var UNLOCK_CH1_PRICE = CH1_PRICE;
  // Mock 加载时间（毫秒）
  var LOADING_DURATION = 8000;
  // 测试用：true 时每次刷新都停在解锁页（跳过"已解锁跳过"逻辑）；上线前改 false
  var FORCE_UNLOCK_PAGE = true;

  /* ========== 视图切换（四状态：unlock / loading / intro / reader） ========== */
  var body = document.body;
  function showUnlock() {
    body.classList.remove("show-loading", "show-reader", "show-intro-only");
  }
  function showLoading() {
    body.classList.remove("show-reader", "show-intro-only");
    body.classList.add("show-loading");
  }
  function showIntro() {
    body.classList.remove("show-loading", "show-reader", "show-intro-only");
    // 如果已解锁过，直接显示简介（跳过解锁页）
    if (hasUnlockedBefore()) {
      body.classList.add("show-intro-only");
    }
  }
  function showReader() { body.classList.add("show-reader"); }

  /* ========== 付费状态管理（共用） ========== */
  var PERSIST_PAY = false;
  var PAY_KEY = "dn_pay_state";
  var UNLOCKED_KEY = "dn_ch1_unlocked"; // 记录是否已解锁过第1章
  var payStorage = PERSIST_PAY ? localStorage : sessionStorage;
  var payState = { balance: INITIAL_BALANCE, unlocked: [], bundle: false };
  try {
    var savedPay = JSON.parse(payStorage.getItem(PAY_KEY) || "null");
    if (savedPay) Object.assign(payState, savedPay);
  } catch (e) {}
  // 测试阶段：每次刷新电量默认恢复到初始值，不读取历史余额
  payState.balance = INITIAL_BALANCE;
  function savePay() { try { payStorage.setItem(PAY_KEY, JSON.stringify(payState)); } catch (e) {} }

  function hasUnlockedBefore() {
    try { return localStorage.getItem(UNLOCKED_KEY) === "1"; } catch (e) { return false; }
  }
  function markUnlocked() { try { localStorage.setItem(UNLOCKED_KEY, "1"); } catch (e) {} }

  function isUnlocked(ch) {
    if (!ch) return false;
    if (!ch.locked) return true;
    if (payState.bundle) return true;
    return payState.unlocked.indexOf(ch.id) !== -1;
  }

  /* ========== 计算全部解锁价 ==========
   * 全部解锁价 = 剩余未付费章节数 × N(chapterPrice) × X(bundleDiscount)
   * N、X 均后台可配置（默认 N=200，X=0.9）
   */
  function calcBulkInfo(fromIdx) {
    var lockedCount = 0;
    for (var i = fromIdx; i < total; i++) {
      if (!isUnlocked(chapters[i])) lockedCount++;
    }
    var rawTotal = lockedCount * CHAPTER_PRICE;
    // 多于 1 章才享折扣；单章按原价
    var discount = lockedCount >= 2 ? BUNDLE_DISCOUNT : 1;
    return { count: lockedCount, finalPrice: Math.round(rawTotal * discount), discount: discount };
  }

  // 折扣文案（如 0.9 → "9折优惠解锁全部"），随 X 可配置
  function bundleLabelText(discount) {
    if (discount >= 1) return "解锁全部";
    var zhe = +(discount * 10).toFixed(1);
    return zhe + "折优惠解锁全部";
  }

  /* ========== Toast ========== */
  var toastTimer = null;
  function showToast(msg) {
    var toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div"); toast.id = "toast"; toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg; toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2000);
  }

  /* ==================== 解锁页逻辑 ==================== */

  // 返回按钮（解锁页左上角）
  document.getElementById("unlockBackBtn").addEventListener("click", function () {
    // 可选：返回上一页或关闭；当前仅隐藏/无操作
    if (history.length > 1) history.back();
  });

  // 电量余额显示
  var unlockBalEl = document.getElementById("unlockBalance");
  function refreshUnlockBalance() {
    if (unlockBalEl) unlockBalEl.innerHTML = "当前电量余额 <b>" + payState.balance + " " + pay.unit + "</b>";
  }
  refreshUnlockBalance();

  // 第1章解锁按钮：价格文案（后台可配置 pay.ch1UnlockPrice，默认 0 = 免费）
  (function initUnlockBtn() {
    var priceEl = document.getElementById("unlockBtnPrice");
    if (priceEl) {
      priceEl.textContent = CH1_PRICE > 0 ? ("⚡ " + CH1_PRICE + " " + UNIT) : "⚡️限时免费";
    }
  })();

  // 解锁按钮点击 → 扣费 → 进入 Loading
  document.getElementById("unlockBtn").addEventListener("click", function () {
    if (payState.balance < UNLOCK_CH1_PRICE) {
      alert("电量不足，需要 " + UNLOCK_CH1_PRICE + " " + pay.unit + " 解锁第1章\n当前余额：" + payState.balance + " " + pay.unit);
      return;
    }
    // 扣费
    payState.balance -= UNLOCK_CH1_PRICE;
    // 标记第1章为已解锁（第1章本身 locked:false，但这里记录"已走过解锁流程"）
    markUnlocked();
    savePay();
    refreshUnlockBalance();
    // 进入 Loading 页
    startLoading();
  });

  /* ==================== Loading 页逻辑 ==================== */

  var loadingTimer = null;
  var loadingStart = 0;

  function startLoading() {
    showLoading();
    loadingStart = Date.now();

    var track = document.getElementById("loadingTextTrack");
    var lines = track ? track.querySelectorAll(".loading-line") : [];
    var idx = 0;

    function showLine(i) {
      lines.forEach(function (l) { l.classList.remove("active"); });
      if (lines[i]) lines[i].classList.add("active");
    }
    showLine(0);

    // 每 2s 轮播下一句（5 条循环）
    var cycleTimer = setInterval(function () {
      idx = (idx + 1) % lines.length;
      showLine(idx);
    }, 2000);
    startLoading._cycleTimer = cycleTimer;

    // 8s 后完成 → 进入简介页
    loadingTimer = setTimeout(function () {
      clearInterval(cycleTimer);
      loadingTimer = null;
      setTimeout(function () { showIntro(); initIntroPage(); }, 300);
    }, LOADING_DURATION);
  }

  // Loading 页返回按钮 → 测试阶段：弹出对话框提示，不跳转
  document.getElementById("loadingBackBtn").addEventListener("click", function () {
    alert("小说正在载入中，请稍候…");
  });

  /* ==================== 简介页逻辑 ==================== */

  var introInited = false;
  function initIntroPage() {
    if (introInited) return;
    introInited = true;

    // 返回按钮
    document.getElementById("backBtn").addEventListener("click", function () {
      if (history.length > 1) history.back();
      else window.scrollTo(0, 0);
    });

    // 封面图
    var coverImg = document.getElementById("coverImg");
    if (novel.cover && novel.cover.image) {
      coverImg.src = novel.cover.image;
      coverImg.onerror = function () { this.style.display = "none"; };
    } else { coverImg.style.display = "none"; }

    // 标题 / 作者
    document.getElementById("novelTitle").textContent = novel.title || "";
    document.getElementById("authorName").textContent = novel.author || "AI基于对话内容生成";

    // 标签（仅当「展示标签 且 不挪到世界分组下」时，渲染在书名上方；否则隐藏顶部空行）
    if (SHOW_TAGS && !TAGS_UNDER_WORLD) {
      var tagsRow = document.getElementById("tagsRow");
      (novel.tags || []).slice(0, 4).forEach(function (t) {
        var s = document.createElement("span"); s.className = "tag-pill"; s.textContent = t;
        tagsRow.appendChild(s);
      });
    } else {
      var tagsRowEmpty = document.getElementById("tagsRow");
      if (tagsRowEmpty) tagsRowEmpty.style.display = "none";
    }

    // 简介
    var introEl = document.getElementById("novelIntro");
    var descWrap = document.querySelector(".intro-desc");
    var moreBtn = document.getElementById("introMore");
    var paras = (novel.intro || "").split(/---+|\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    paras.forEach(function (p) {
      var el = document.createElement("p"); el.textContent = p; introEl.appendChild(el);
    });
    if (introEl.scrollHeight <= 130) moreBtn.style.display = "none";
    moreBtn.addEventListener("click", function () {
      var expanded = descWrap.classList.toggle("expanded");
      moreBtn.textContent = expanded ? "收起" : "更多";
    });

    /* ---------- 简介页目录 ---------- */
    buildToc();

    /* ---------- 开始阅读 ---------- */
    var startBtn = document.getElementById("startReadBtn");
    var READ_KEY = "dialogue_novel_read";
    var hasRead = !!localStorage.getItem(READ_KEY);
    startBtn.textContent = hasRead ? "继续阅读" : "点击开始阅读";

    function goRead(chapterIdx) {
      localStorage.setItem(READ_KEY, "1");
      showReader();
      initReader(typeof chapterIdx === "number" ? chapterIdx : (hasRead ? -1 : 0));
    }
    startBtn.addEventListener("click", function () { goRead(); });
    window._goRead = goRead; // 暴露给目录点击

    /* ---------- 多章折扣按钮 ---------- */
    document.getElementById("introBulkBtn").addEventListener("click", function () { openIntroPay(-1); });

    /* ---------- 简介页付费半弹窗 ---------- */
    bindIntroPayEvents();
  }

  /* ---------- 目录构建 ---------- */
  var toc = document.getElementById("tocList");
  function buildToc() {
    toc.innerHTML = "";
    var lastWorld = -1;
    chapters.slice(0, 3).forEach(function (ch, i) {
      if (CHAPTERS_PER_WORLD > 0) {
        var w = worldOf(i);
        if (w !== lastWorld) {
          lastWorld = w;
          var wh = document.createElement("li");
          wh.className = "toc-world";
          wh.textContent = worldTitleOf(w);
          toc.appendChild(wh);
          // 仅在第一个世界分组头下方，插入标签（需 tagsUnderWorld=true 且 showTags=true）
          if (TAGS_UNDER_WORLD && w === 1 && SHOW_TAGS) {
            var tl = document.createElement("li");
            tl.className = "toc-tags";
            (novel.tags || []).slice(0, 4).forEach(function (t) {
              var s = document.createElement("span"); s.className = "tag-pill"; s.textContent = t;
              tl.appendChild(s);
            });
            toc.appendChild(tl);
          }
        }
      }
      var unlocked = isUnlocked(ch);
      var li = document.createElement("li");
      if (ch.locked && !unlocked) li.className = "locked";
      var right = unlocked
        ? '<span class="arrow"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></span>'
        : '<span class="lock-tag">付费</span>';
      li.innerHTML = '<span>' + ch.title + '</span>' + right;
      li.addEventListener("click", function () {
        if (unlocked) { if (window._goRead) window._goRead(i); }
        else { openIntroPay(i); }
      });
      toc.appendChild(li);
    });

    var bulkBtn = document.getElementById("introBulkBtn");
    if (bulkBtn) {
      var anyLocked = false;
      for (var li2 = 0; li2 < total; li2++) {
        if (!isUnlocked(chapters[li2])) { anyLocked = true; break; }
      }
      bulkBtn.style.display = anyLocked ? "" : "none";
    }
  }

  /* ---------- 简介页付费半弹窗 ---------- */
  var introPayMask, introPaySheet, introBundleLabel, introBundlePriceEl;
  var introSingleLabel, introSinglePriceEl, introPayBundle, introPaySingle, introPayTargetIdx;

  function bindIntroPayEvents() {
    introPayMask = document.getElementById("introPayMask");
    introPaySheet = document.getElementById("introPaySheet");
    introBundleLabel = document.getElementById("introBundleLabel");
    introBundlePriceEl = document.getElementById("introBundlePrice");
    introSingleLabel = document.getElementById("introSingleLabel");
    introSinglePriceEl = document.getElementById("introSinglePrice");
    introPayBundle = document.getElementById("introPayBundle");
    introPaySingle = document.getElementById("introPaySingle");
    introPayTargetIdx = -1;

    document.getElementById("introPayClose").addEventListener("click", closeIntroPay);
    introPayMask.addEventListener("click", closeIntroPay);

    introPayBundle.addEventListener("click", function () {
      var fromIdx = -1;
      for (var fi = 0; fi < total; fi++) {
        if (!isUnlocked(chapters[fi])) { fromIdx = fi; break; }
      }
      if (fromIdx < 0) { closeIntroPay(); return; }
      var bulk = calcBulkInfo(fromIdx), price = bulk.finalPrice;
      if (payState.balance < price) { alert("电量不足，当前余额 " + payState.balance + " " + pay.unit); return; }
      payState.balance -= price;
      for (var i = fromIdx; i < total; i++) {
        var c = chapters[i];
        if (c.locked && payState.unlocked.indexOf(c.id) === -1) payState.unlocked.push(c.id);
      }
      savePay(); closeIntroPay(); buildToc(); showToast("购买成功！");
    });

    introPaySingle.addEventListener("click", function () {
      var targetIdx = introPayTargetIdx;
      if (targetIdx < 0 || targetIdx >= total) return;
      var ch = chapters[targetIdx];
      if (!ch.locked) { closeIntroPay(); return; }
      var price = CHAPTER_PRICE;
      if (payState.balance < price) { alert("电量不足，当前余额 " + payState.balance + " " + pay.unit); return; }
      payState.balance -= price;
      if (payState.unlocked.indexOf(ch.id) === -1) payState.unlocked.push(ch.id);
      savePay(); closeIntroPay(); buildToc(); showToast("购买成功！");
    });
  }

  function openIntroPay(idx) {
    introPayTargetIdx = idx;
    var bulkFrom = -1;
    for (var bi = 0; bi < total; bi++) {
      if (!isUnlocked(chapters[bi])) { bulkFrom = bi; break; }
    }
    var bulk = bulkFrom >= 0 ? calcBulkInfo(bulkFrom) : { count: 0, finalPrice: 0, discount: 1 };

    if (bulk.count > 1) {
      introBundleLabel.textContent = bundleLabelText(bulk.discount);
      introBundlePriceEl.textContent = bulk.finalPrice + " " + pay.unit;
      introPayBundle.style.display = "";
    } else { introPayBundle.style.display = "none"; }

    var firstLocked = -1;
    for (var fi = 0; fi < total; fi++) {
      if (!isUnlocked(chapters[fi])) { firstLocked = fi; break; }
    }
    if (firstLocked >= 0) {
      var fCh = chapters[firstLocked];
      var fPrice = CHAPTER_PRICE;
      introSingleLabel.textContent = "解锁下 1 章";
      introSinglePriceEl.textContent = fPrice + " " + pay.unit;
      introPayTargetIdx = firstLocked;
      introPaySingle.style.display = "";
    } else { introPaySingle.style.display = "none"; }

    var b = document.getElementById("introPayBalance");
    if (b) b.innerHTML = "当前电量余额 <b>" + payState.balance + " " + pay.unit + "</b>";
    introPayMask.classList.add("open"); introPaySheet.classList.add("open");
  }
  function closeIntroPay() { introPayMask.classList.remove("open"); introPaySheet.classList.remove("open"); }

  /* 左滑进入阅读（简介页，仅当 swipeToRead 开启时生效） */
  if (SWIPE_TO_READ) {
    var introPage = document.getElementById("introPage");
    var sx = 0, sy = 0, tracking = false;
    introPage.addEventListener("pointerdown", function (e) { sx = e.clientX; sy = e.clientY; tracking = true; }, { passive: true });
    introPage.addEventListener("pointerup", function (e) {
      if (!tracking) return; tracking = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (dx < -50 && Math.abs(dx) > Math.abs(dy) * 1.3) { if (window._goRead) window._goRead(); }
    }, { passive: true });
  }


  /* ==================== 阅读页逻辑 ==================== */

  var readerInited = false;
  var page, topbar, statusbar, scroll, track, chapterName, fontVal;
  var current = 0, pages = [], pageIndex = 0, hasLockedNext = false, nextIsChat = false;

  function initReader(startChapter) {
    if (!readerInited) {
      page = document.getElementById("readerPage");
      topbar = document.getElementById("topbar");
      statusbar = document.getElementById("statusbar");
      scroll = document.getElementById("readerScroll");
      track = document.getElementById("readerTrack");
      chapterName = document.getElementById("chapterName");
      fontVal = document.getElementById("fontVal");
      bindReaderEvents();
      readerInited = true;
    }

    // 读取设置
    var store = { fontSize: 18, theme: (novel.defaultTheme || "theme-blue"), lastChapter: 0, lastPage: 0 };
    try { var sv = JSON.parse(localStorage.getItem("dn_reader_setting") || "{}"); Object.assign(store, sv); } catch (e) {}
    window._readerStore = store;
    function saveSetting() { try { localStorage.setItem("dn_reader_setting", JSON.stringify(store)); } catch (e) {} }

    // 解析起始章节
    var sc = typeof startChapter === "number" ? startChapter : store.lastChapter || 0;
    if (sc < 0) sc = store.lastChapter || 0;
    if (sc >= total) sc = total - 1;
    if (!isUnlocked(chapters[sc])) { sc = 0; }
    var sp = store.lastPage || 0;

    document.getElementById("drawerTitle").textContent = novel.title;
    document.getElementById("drawerMeta").textContent = "共 " + total + " 章 · " + (novel.wordCount || "");

    buildReaderToc();

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        renderChapter(sc, false);
        if (sp > 0 && sp < pages.length) { pageIndex = sp; showPage(false); }
      });
    });

    if (window.ResizeObserver) {
      var lastH = 0, ro = new ResizeObserver(function () {
        var h = scroll.clientHeight;
        if (Math.abs(h - lastH) > 20) { lastH = h; renderChapter(current, true); }
      });
      ro.observe(scroll);
    }

    /* ---- 内部函数闭包 ---- */
    function pageCount() { return pages.length + (hasLockedNext ? 1 : 0); }

    function layoutPages(paras) {
      if (!paras.length) return [[""]];
      var measure = document.createElement("div");
      measure.className = "reader-page-item";
      measure.style.cssText = "position:absolute;visibility:hidden;left:0;top:0;width:100%;height:auto;z-index:-1;pointer-events:none;";
      scroll.appendChild(measure);
      var cs = getComputedStyle(measure);
      var padTop = parseFloat(cs.paddingTop) || 0;
      var padBot = parseFloat(cs.paddingBottom) || 0;
      var availH = scroll.clientHeight - padTop - padBot;
      if (!availH || availH < 60) availH = 560;
      var groups = [], cur = [], curH = 0;
      for (var i = 0; i < paras.length; i++) {
        var p = document.createElement("p"); p.textContent = paras[i]; p.style.fontSize = store.fontSize + "px";
        measure.appendChild(p);
        var pcs = getComputedStyle(p);
        var h = p.offsetHeight + (parseFloat(pcs.marginTop) || 0) + (parseFloat(pcs.marginBottom) || 0);
        measure.removeChild(p);
        if (cur.length && curH + h > availH) { groups.push(cur); cur = []; curH = 0; }
        cur.push(paras[i]); curH += h;
      }
      if (cur.length) groups.push(cur);
      scroll.removeChild(measure);
      return groups.length ? groups : [paras];
    }

    function renderChapter(idx, keepPage) {
      current = Math.max(0, Math.min(total - 1, idx));
      store.lastChapter = current; saveSetting();
      var ch = chapters[current];
      chapterName.textContent = ch.title;
      pages = layoutPages(ch.content || []);
      pageIndex = keepPage ? Math.min(pageIndex, pages.length - 1) : 0;
      hasLockedNext = (current < total - 1) && !isUnlocked(chapters[current + 1]);

      track.style.transition = "none"; track.innerHTML = "";
      var lastPageIdx = pages.length - 1;
      pages.forEach(function (pg, pi) {
        var item = document.createElement("div"); item.className = "reader-page-item";
        var content = document.createElement("div"); content.className = "reader-content";
        pg.forEach(function (t) {
          var p = document.createElement("p"); p.textContent = t; content.appendChild(p);
        });
        item.appendChild(content);
        if (current === total - 1 && pi === lastPageIdx) {
          var tip = document.createElement("div"); tip.className = "chapter-end-tip";
          tip.innerHTML = '<span class="end-line"></span><span class="end-text">继续聊天触发小说更新</span><span class="end-line"></span>';
          content.appendChild(tip);
        }
        track.appendChild(item);
      });
      if (hasLockedNext) {
        var lockedItem = document.createElement("div"); lockedItem.className = "reader-page-item locked-next-page";
        var lockedContent = document.createElement("div"); lockedContent.className = "reader-content";
        appendInlinePayButtons(lockedContent, current + 1);
        lockedItem.appendChild(lockedContent); track.appendChild(lockedItem);
      }
      showPage(false); applySetting(); renderTocActive();
    }

    function showPage(animate) {
      track.style.transition = animate === false ? "none" : "";
      track.style.transform = "translateX(" + (-pageIndex * 100) + "%)";
      // 内联付费页(hasLockedNext && 最后一页)是下一章的入口/封面，
      // 标题应显示下一章名称；其余页面显示当前章节标题
      if (hasLockedNext && pageIndex === pages.length) {
        var nextCh = chapters[current + 1];
        chapterName.textContent = nextCh ? nextCh.title : chapters[current].title;
      } else {
        chapterName.textContent = chapters[current].title;
      }
      applyFont();
      updateNavState();
      store.lastChapter = current; store.lastPage = pageIndex; saveSetting();
    }

    function applyFont() {
      fontVal.textContent = store.fontSize;
      var item = track.children[pageIndex]; if (!item) return;
      var ps = item.querySelectorAll(".reader-content p");
      for (var i = 0; i < ps.length; i++) ps[i].style.fontSize = store.fontSize + "px";
    }

    function applySetting() {
      applyFont();
      // 保留 view-reader / view-intro / view-unlock / view-loading 等视图 class，只替换主题
      page.className = page.className.replace(/\btheme-\w+/g, '') + ' ' + store.theme;
      page.className = page.className.replace(/\s{2,}/g, ' ').trim();
      if (store.theme === "theme-night") statusbar.style.color = "#b5b5b9";
      else if (store.theme === "theme-green") statusbar.style.color = "#2a3828";
      else if (store.theme === "theme-blue") statusbar.style.color = "#33404f";
      else statusbar.style.color = "#3d3424";
      Array.prototype.forEach.call(document.getElementById("themeRow").children, function (dot) {
        dot.classList.toggle("active", dot.dataset.theme === store.theme);
      });
    }

    // 章节切换（上一章/下一章）也使用与翻页相同的横向滑动，避免跳屏
    function animateToChapter(targetIdx) {
      var groups = layoutPages(chapters[targetIdx].content || []);
      groups.forEach(function (pg) {
        var item = document.createElement("div"); item.className = "reader-page-item";
        var content = document.createElement("div"); content.className = "reader-content";
        pg.forEach(function (t) {
          var p = document.createElement("p"); p.textContent = t; p.style.fontSize = store.fontSize + "px";
          content.appendChild(p);
        });
        item.appendChild(content); track.appendChild(item);
      });
      // 当前位于本章最后一页（pageIndex = pages.length-1），滑到下一章首页
      var fired = false;
      var done = function () {
        if (fired) return; fired = true;
        track.removeEventListener("transitionend", done);
        renderChapter(targetIdx, false);
      };
      track.style.transition = "none";
      track.style.transform = "translateX(" + (-pageIndex * 100) + "%)";
      void track.offsetWidth;
      track.style.transition = "";
      track.style.transform = "translateX(" + (-(pages.length) * 100) + "%)";
      track.addEventListener("transitionend", done);
      setTimeout(done, 420);
    }

    function animateToChapterPrev(targetIdx) {
      var groups = layoutPages(chapters[targetIdx].content || []);
      var frag = document.createDocumentFragment();
      groups.forEach(function (pg) {
        var item = document.createElement("div"); item.className = "reader-page-item";
        var content = document.createElement("div"); content.className = "reader-content";
        pg.forEach(function (t) {
          var p = document.createElement("p"); p.textContent = t; p.style.fontSize = store.fontSize + "px";
          content.appendChild(p);
        });
        item.appendChild(content); frag.appendChild(item);
      });
      track.insertBefore(frag, track.firstChild);
      var prevLen = groups.length;
      var fired = false;
      var done = function () {
        if (fired) return; fired = true;
        track.removeEventListener("transitionend", done);
        renderChapter(targetIdx, false);
        if (pages.length) { pageIndex = pages.length - 1; showPage(false); }
      };
      // 当前位于本章首页（在扩展轨道中 index = prevLen），滑到上一章末页（index = prevLen-1）
      track.style.transition = "none";
      track.style.transform = "translateX(" + (-prevLen * 100) + "%)";
      void track.offsetWidth;
      track.style.transition = "";
      track.style.transform = "translateX(" + (-(prevLen - 1) * 100) + "%)";
      track.addEventListener("transitionend", done);
      setTimeout(done, 420);
    }

    function goPrev() {
      if (pageIndex > 0) { pageIndex--; showPage(true); return; }
      if (current > 0) {
        var prev = chapters[current - 1];
        if (!isUnlocked(prev)) return;
        animateToChapterPrev(current - 1);
      }
    }
    function goNext() {
      if (nextIsChat) { openChatBot(); return; }
      if (pageIndex < pageCount() - 1) { pageIndex++; showPage(true); return; }
      if (current < total - 1) {
        var next = chapters[current + 1];
        if (!isUnlocked(next)) return;
        animateToChapter(current + 1);
      }
    }

    function openChatBot() {
      var w = window.open(CHAT_BOT_URL, "_blank");
      if (!w) window.location.href = CHAT_BOT_URL;
    }

    function updateNavState() {
      var atFirst = (pageIndex === 0 && current === 0);
      var atLastPage = (pageIndex === pageCount() - 1);
      var atLast = atLastPage && current === total - 1;
      var nextLocked = (atLastPage && hasLockedNext);
      var nextBtn = document.getElementById("nextBtn");
      var nextLabel = nextBtn.querySelector("span");
      document.getElementById("prevBtn").style.opacity = atFirst ? .35 : 1;
      if (atLast && NEEDS_MORE_CHAT) {
        nextBtn.classList.add("next-chat");
        nextBtn.style.opacity = 1;
        if (nextLabel) nextLabel.textContent = "去聊天";
        nextIsChat = true;
      } else {
        nextBtn.classList.remove("next-chat");
        if (nextLabel) nextLabel.textContent = "下一页";
        nextBtn.style.opacity = (atLast || nextLocked) ? .35 : 1;
        nextIsChat = false;
      }
    }

    /* 目录 */
    function buildReaderToc() {
      var dl = document.getElementById("drawerList"); dl.innerHTML = "";
      var lastWorld = -1;
      chapters.forEach(function (ch, i) {
        if (CHAPTERS_PER_WORLD > 0) {
          var w = worldOf(i);
          if (w !== lastWorld) {
            lastWorld = w;
            var wh = document.createElement("li");
            wh.className = "drawer-world";
            wh.textContent = worldTitleOf(w);
            dl.appendChild(wh);
          }
        }
        var li = document.createElement("li");
        var unlocked = isUnlocked(ch);
        if (!unlocked) li.className = "locked";
        li.textContent = ch.title; li.dataset.idx = i;
        li.addEventListener("click", function () {
          if (!isUnlocked(chapters[i])) { closeDrawer(); openPay(i); return; }
          renderChapter(i, false); closeDrawer();
        });
        dl.appendChild(li);
      });
    }
    function renderTocActive() {
      Array.prototype.forEach.call(document.getElementById("drawerList").children, function (li) {
        li.classList.toggle("active", Number(li.dataset.idx) === current);
      });
    }
    var drawer = document.getElementById("drawer"), drawerMask = document.getElementById("drawerMask");
    function openDrawer() { drawer.classList.add("open"); drawerMask.classList.add("open"); buildReaderToc(); renderTocActive(); }
    function closeDrawer() { drawer.classList.remove("open"); drawerMask.classList.remove("open"); }
    drawerMask.addEventListener("click", closeDrawer);
    document.getElementById("tocBtn2").addEventListener("click", openDrawer);

    /* 设置 */
    var sheet = document.getElementById("sheet"), sheetMask = document.getElementById("sheetMask");
    function openSheet() { sheet.classList.add("open"); sheetMask.classList.add("open"); }
    function closeSheet() { sheet.classList.remove("open"); sheetMask.classList.remove("open"); }
    sheetMask.addEventListener("click", closeSheet);
    document.getElementById("setBtn").addEventListener("click", openSheet);
    document.getElementById("sheetClose").addEventListener("click", closeSheet);

    document.getElementById("fontMinus").addEventListener("click", function () {
      store.fontSize = Math.max(14, store.fontSize - 1); renderChapter(current, true); saveSetting();
    });
    document.getElementById("fontPlus").addEventListener("click", function () {
      store.fontSize = Math.min(26, store.fontSize + 1); renderChapter(current, true); saveSetting();
    });
    var themeRow = document.getElementById("themeRow");
    Array.prototype.forEach.call(themeRow.children, function (dot) {
      dot.addEventListener("click", function () { store.theme = dot.dataset.theme; applySetting(); saveSetting(); });
    });

    /* 付费弹窗 */
    function chapterTitleShort(ch) {
      if (!ch) return ""; var m = ch.title.replace(/^第\d+章\s*/, ""); return m || ch.title;
    }

    var payMask = document.getElementById("payMask"), paySheet = document.getElementById("paySheet");
    var payTitle = document.getElementById("payTitle"), paySub = document.getElementById("paySub");
    var payBundleLabel = document.getElementById("payBundleLabel"), payBundlePriceEl = document.getElementById("payBundlePrice");
    var paySingleLabel = document.getElementById("paySingleLabel"), paySinglePriceEl = document.getElementById("paySinglePrice");
    var payOptBundle = document.getElementById("payOptBundle"), payOptSingle = document.getElementById("payOptSingle");
    var payBalance = document.getElementById("payBalance");
    var payMode = "chapter", payTargetIdx = -1;

    function openPay(idx) {
      payMode = "chapter";
      var firstLocked = idx;
      for (var li = 0; li < total; li++) { if (!isUnlocked(chapters[li])) { firstLocked = li; break; } }
      payTargetIdx = firstLocked;
      var ch = chapters[payTargetIdx];
      var unitPrice = CHAPTER_PRICE;
      payTitle.textContent = "解锁下一章";
      paySub.textContent = "解锁后即可畅读「" + chapterTitleShort(ch) + "」完整内容";
      paySingleLabel.textContent = "解锁本章";
      paySinglePriceEl.textContent = unitPrice + " " + pay.unit;
      var bulkFrom = idx;
      for (var bi = 0; bi < total; bi++) { if (!isUnlocked(chapters[bi])) { bulkFrom = bi; break; } }
      var bulk = calcBulkInfo(bulkFrom);
      if (bulk.count > 1) {
        payBundleLabel.textContent = bundleLabelText(bulk.discount);
        payBundlePriceEl.textContent = bulk.finalPrice + " " + pay.unit;
        payOptBundle.style.display = "";
      } else { payOptBundle.style.display = "none"; }
      payBalance.innerHTML = "当前电量余额 <b>" + payState.balance + " " + pay.unit + "</b>";
      payMask.classList.add("open"); paySheet.classList.add("open");
    }

    function openLowBalance() {
      payMode = "low";
      payTitle.textContent = "电量不足"; paySub.textContent = "电量不足，快去充值吧";
      payBundleLabel.textContent = "前往充电"; payBundlePriceEl.textContent = "";
      paySingleLabel.textContent = "返回"; paySinglePriceEl.textContent = "";
      payOptBundle.style.display = ""; payOptSingle.style.display = "";
      payBalance.innerHTML = "当前电量余额 <b>" + payState.balance + " " + pay.unit + "</b>";
      payMask.classList.add("open"); paySheet.classList.add("open");
    }

    function closePay() { payMask.classList.remove("open"); paySheet.classList.remove("open"); }

    payOptBundle.addEventListener("click", function () {
      if (payMode === "low") { payState.balance += 1000; savePay(); closePay(); alert("充值成功，已到账 1000 " + pay.unit + "（演示）"); return; }
      if (payMode === "chapter") {
        var bf = 0; for (var bi = 0; bi < total; bi++) { if (!isUnlocked(chapters[bi])) { bf = bi; break; } }
        var bk = calcBulkInfo(bf), price = bk.finalPrice;
        if (payState.balance < price) { openLowBalance(); return; }
        payState.balance -= price;
        for (var i = bf; i < total; i++) { var c = chapters[i]; if (!isUnlocked(c) && payState.unlocked.indexOf(c.id) === -1) payState.unlocked.push(c.id); }
        savePay(); closePay(); renderChapter(bf, false); buildReaderToc(); renderTocActive(); showToast("购买成功！");
      }
    });

    payOptSingle.addEventListener("click", function () {
      if (payMode === "low") { closePay(); return; }
      if (payMode === "chapter") {
        var ti = payTargetIdx, ch = chapters[ti]; if (!ch) return;
        if (!ch.locked) { closePay(); renderChapter(ti, false); return; }
        var price = CHAPTER_PRICE;
        if (payState.balance < price) { openLowBalance(); return; }
        payState.balance -= price;
        if (payState.unlocked.indexOf(ch.id) === -1) payState.unlocked.push(ch.id);
        savePay(); closePay(); renderChapter(ti, false); buildReaderToc(); renderTocActive(); showToast("购买成功！");
      }
    });
    payMask.addEventListener("click", closePay);

    /* 内联付费按钮 */
    function appendInlinePayButtons(container, lockedIdx) {
      var wrap = document.createElement("div"); wrap.className = "inline-pay-wrap";
      var bulkFrom = lockedIdx;
      for (var bi = 0; bi < total; bi++) { if (!isUnlocked(chapters[bi])) { bulkFrom = bi; break; } }
      var bulk = calcBulkInfo(bulkFrom);
      if (bulk.count > 1) {
        var btnB = document.createElement("button"); btnB.className = "inline-pay-btn inline-pay-bulk";
        var dt = bundleLabelText(bulk.discount);
        btnB.innerHTML = '<span class="inline-pay-label">' + dt + '</span><span class="inline-pay-tag"><span class="inline-tag-icon">🐾</span><span class="inline-tag-price">' + bulk.finalPrice + ' ' + pay.unit + '</span></span>';
        btnB.addEventListener("click", function () { doInlineBulk(lockedIdx); }); wrap.appendChild(btnB);
      }
      var ch2 = chapters[lockedIdx], up = CHAPTER_PRICE;
      var btnS = document.createElement("button"); btnS.className = "inline-pay-btn inline-pay-single";
      btnS.innerHTML = '<span class="inline-pay-label">解锁本章</span><span class="inline-pay-tag"><span class="inline-tag-icon">🐾</span><span class="inline-tag-price">' + up + ' ' + pay.unit + '</span></span>';
      btnS.addEventListener("click", function () { doInlineSingle(lockedIdx); }); wrap.appendChild(btnS);

      // 底部电量余额
      var bal = document.createElement("div"); bal.className = "inline-pay-balance";
      bal.innerHTML = "当前电量余额 <b>" + payState.balance + " " + pay.unit + "</b>";
      wrap.appendChild(bal);

      container.appendChild(wrap);
    }

    function doInlineBulk(fromIdx) {
      var bf = fromIdx; for (var bi = 0; bi < total; bi++) { if (!isUnlocked(chapters[bi])) { bf = bi; break; } }
      var bk = calcBulkInfo(bf), price = bk.finalPrice;
      if (payState.balance < price) { alert("电量不足，当前余额 " + payState.balance + " " + pay.unit); return; }
      payState.balance -= price;
      for (var i = bf; i < total; i++) { var c = chapters[i]; if (!isUnlocked(c) && payState.unlocked.indexOf(c.id) === -1) payState.unlocked.push(c.id); }
      savePay(); renderChapter(bf, false); buildReaderToc(); renderTocActive(); showToast("购买成功！");
    }

    function doInlineSingle(idx) {
      var ch = chapters[idx]; if (!ch) return;
      var price = CHAPTER_PRICE;
      if (payState.balance < price) { alert("电量不足，当前余额 " + payState.balance + " " + pay.unit); return; }
      payState.balance -= price;
      if (payState.unlocked.indexOf(ch.id) === -1) payState.unlocked.push(ch.id);
      savePay(); renderChapter(idx, false); buildReaderToc(); renderTocActive(); showToast("购买成功！");
    }

    /* 翻页按钮 & 滑动 */
    document.getElementById("prevBtn").addEventListener("click", goPrev);
    document.getElementById("nextBtn").addEventListener("click", goNext);

    var rsx = 0, rsy = 0, rtracking = false;
    scroll.addEventListener("pointerdown", function (e) { rsx = e.clientX; rsy = e.clientY; rtracking = true; }, { passive: true });
    scroll.addEventListener("pointerup", function (e) {
      if (!rtracking) return; rtracking = false;
      var dx = e.clientX - rsx, dy = e.clientY - rsy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { if (dx < 0) goNext(); else goPrev(); }
    }, { passive: true });

    // 暴露给外部（简介页目录点击跳转后刷新）
    window._refreshReader = function () { buildReaderToc(); };
  }

  /* 绑定阅读页返回按钮（切回简介） */
  document.getElementById("readerBackBtn").addEventListener("click", function () { showIntro(); });

  function bindReaderEvents() {} // 占位，事件在 initReader 内绑定

  /* ========== 入口：判断走解锁页还是直接进简介页 ========== */
  (function bootstrap() {
    if (FORCE_UNLOCK_PAGE) {
      // 测试模式：强制显示解锁页
      showUnlock();
    } else if (hasUnlockedBefore()) {
      // 已解锁过 → 直接初始化并显示简介页
      showIntro();
      initIntroPage();
    } else {
      // 未解锁 → 显示解锁页
      showUnlock();
    }
  })();

})();
