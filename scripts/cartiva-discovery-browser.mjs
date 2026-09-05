import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Isolated browser/profile. API fault injection never touches a real retailer cart.
const target = process.argv[2] ?? "http://localhost:3000/compare";
const port = 9241;
const profile = mkdtempSync(path.join(tmpdir(), "cartiva-discovery-"));
const chrome = spawn(process.env.CARTIVA_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
const retailer = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Isolated retailer sign-in test</title><p>Sign-in simulation. No credentials.</p>"); });
await new Promise((resolve) => retailer.listen(9242, '127.0.0.1', resolve));
const results = [];
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((p) => p.type === "page"); } catch { await delay(100); }
  }
  assert(page, "Chrome debugging unavailable");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let id = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)); const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = async (expression, message, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await delay(100); }
    throw new Error(`${message}: ${await evaluate("document.body.innerText.slice(-1800)")}`);
  };
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('Missing/enabled: '+${JSON.stringify(text)}); b.click(); })()`);
  const input = (selector, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing input'); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const realFetch=window.fetch.bind(window); window.qa={calls:[], failure:'', connected:true};
    window.fetch=async (url,init={})=>{
      const route=String(url); if(!route.startsWith('/api/kroger/') && route!=='/api/knowledge/feedback') return realFetch(url,init);
      window.qa.calls.push(route); const body=init.body?JSON.parse(init.body):{};
      if(route==='/api/knowledge/feedback') {
        window.qa.feedbackBody=body;
        return window.qa.feedbackFailure ? Response.json({error:'Feedback unavailable'},{status:409}) : Response.json({result:{recorded:true}});
      }
      if(route.endsWith('/cart/review')) {
        if(!window.qa.reviewOwner) return Response.json({error:'Reconnect Cartiva before confirming this review.'},{status:401});
        if(init.method==='POST') {
          if(window.qa.reviewFailure) return Response.json({error:'Review storage unavailable. Please retry.'},{status:503});
          if(window.qa.newerPending) localStorage.setItem('cartiva-kroger-pending-cart-v1',JSON.stringify(window.qa.newerPending));
          return Response.json({acknowledged:true});
        }
        return Response.json({operationId:'legacy-blocked-operation-12345'});
      }
      if(route.endsWith('/oauth/start')) {
        window.qa.reviewOwner=true; window.qa.connected=true;
        return Response.json({authorizationUrl:'http://127.0.0.1:9242/'});
      }
      if(route.endsWith('/auth/status')) return Response.json({configured:true,connected:window.qa.connected});
      if(route.endsWith('/locations')) {
        const zip=body.zipCode; await new Promise(r=>setTimeout(r,zip==='11111'?650:30));
        return Response.json({zipCode:zip,locations:[{locationId:'03500529',name:'QA Store '+zip,chain:'Kroger',address:{addressLine1:'1 Main',city:'Dallas',state:'TX',zipCode:zip},departments:[]}]});
      }
      if(route.endsWith('/search')) {
        window.qa.lastSearch=body;
        await new Promise(r=>setTimeout(r,150));
        if(window.qa.failure==='500') return Response.json({error:'Store temporarily unavailable. Try again.'},{status:500});
        if(window.qa.failure==='malformed') return new Response(JSON.stringify({type:'item',index:999,result:null})+'\\n');
        const now=new Date().toISOString();
        const events=body.items.map((item,index)=>{
          const upc=String(index+1111012000).padStart(13,'0');
          const product={retailer:'kroger',id:upc,productId:upc,upc,title:item.text,price:3,priceCents:300,link:'https://www.kroger.com/p/'+upc,sponsored:false,size:{amount:1,unit:'count',kind:'count',baseAmount:1,baseUnit:'each',label:'1 count'},inStock:true,availabilityStatus:'in_stock',cartEligible:true,identityVerified:true,dataSource:'kroger_public_api',confidence:'high',score:10,comparablePrice:3,matchedTerms:[],reasons:[],priceProvenance:{retailer:'kroger',priceSource:'kroger_location_product',priceScope:'exact_store',priceReliability:'verified',exactStoreVerified:true,locationId:body.locationId,location:{requestedStoreId:body.locationId,observedStoreId:body.locationId,responseProvesLocation:true,storeMatched:true},fulfillment:[body.fulfillmentMode],checkedAt:now}};
          const correction=window.qa.feedback ? {receipt:'qa-ephemeral-receipt-'+index,offers:[{upc,productId:upc,title:product.title,package:'1 count',canChoose:true},{upc:String(Number(upc)+100).padStart(13,'0'),productId:String(Number(upc)+100).padStart(13,'0'),title:product.title+' alternative',package:'1 count',canChoose:true}]} : undefined;
          return {type:'item',retailer:'kroger',phase:'verification',index,mode:'live',checkedAt:now,correction,cartAutomation:{enabled:true,requiresCustomerConnection:true},diagnostics:{locationId:body.locationId,verificationStatus:'verified',searchResultCount:1},result:{retailer:'kroger',requestedItem:item.text,recommended:product,alternatives:[],confidence:'high',status:'matched',explanation:'QA verified fixture'}};
        });
        if(window.qa.failure==='partial') events.pop();
        return new Response(events.map(e=>JSON.stringify(e)).join('\\n')+'\\n',{headers:{'Content-Type':'application/x-ndjson'}});
      }
      if(route.endsWith('/cart')) return Response.json({success:true,operationId:body.operationId,itemCount:body.items.length,addedCount:body.items.reduce((n,i)=>n+i.quantity,0),cartUrl:'https://www.kroger.com/cart',selectedSearchLocation:{locationId:body.locationId},locationBoundByCartApi:false,message:'Kroger accepted these items. Confirm checkout store.'});
      throw Error('Unexpected mocked route '+route);
    };
  })();` });
  await send("Page.navigate", { url: target });
  await until("document.querySelector('[aria-label=\"Your grocery list\"]')", "workspace hydration"); await delay(600);
  const navigateWorkspace = async (rawInput, extra = {}) => {
    await evaluate(`localStorage.setItem('cartiva-web-workspace-v1',${JSON.stringify(JSON.stringify({ rawInput, zipCode: "75204", quantities: {}, fulfillmentMode: "pickup", listName: "Discovery groceries", ...extra }))})`);
    await send("Page.navigate", { url: `${target}?discovery=${Date.now()}` });
    await until(`document.querySelectorAll('[aria-label="Your grocery list"] [id^="list-item-"]').length === ${Math.min(rawInput.split('\n').length,50)}`, "workspace hydrated"); await delay(300);
  };
  const rows = "document.querySelectorAll('[aria-label=\"Your grocery list\"] [id^=\"list-item-\"]').length";
  await input('input[placeholder="Add milk, produce, pantry…"]', 'White bread'); await click('Add');
  await until(`${rows}===1`, "immediate entry");
  assert.equal(await evaluate("qa.calls.filter(c=>c.endsWith('/search')).length"), 0); results.push("typing/add: no retailer search");
  await navigateWorkspace("coffee\nrice\nbananas");
  await evaluate("document.querySelector('[aria-label=\"Increase Bananas quantity\"]').click()"); await delay(150);
  await evaluate("document.querySelector('[aria-label=\"Remove Coffee\"]').click()"); await delay(200);
  assert.match(await evaluate("document.querySelector('[aria-label=\"Quantity for Bananas\"]').textContent"), /2/); results.push("delete preserves later quantity override");
  for(const count of [1,5,10,20,50,100]) {
    await navigateWorkspace(Array.from({length:count},()=>"White bread").join('\n'));
    assert.equal(await evaluate(rows), Math.min(count,50));
    if(count===100) {
      assert.match(await evaluate("document.body.innerText"), /100 groceries\. Compare up to 50/);
      await click('Edit full list');
      assert.equal(await evaluate("document.querySelector('textarea').value.split('\\n').length"),100);
    }
  }
  results.push("1/5/10/20/50/100 rows; full overflow remains editable");
  const five="Large eggs, 18 count\n2% milk, 1 gallon\nWhite bread\nCoke Zero, 12 pack\nGreek yogurt, 32 oz";
  await navigateWorkspace(five);
  await input('#cartiva-zip','11111'); await click('Find stores');
  await input('#cartiva-zip','22222'); await click('Find stores');
  await until("document.body.innerText.includes('QA Store 22222')", 'new ZIP wins'); await delay(800);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /QA Store 11111/);
  results.push('out-of-order ZIP responses cannot restore old store');
  for(const failure of ['500','malformed','partial','']) {
    await evaluate(`qa.failure=${JSON.stringify(failure)}`);
    await click('Compare basket');
    await until("!document.body.innerText.includes('Checking official') && !document.body.innerText.includes('item by item') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Compare basket'&&!b.disabled || b.textContent.trim()==='Compare again'&&!b.disabled)", 'comparison settles');
    await delay(500);
    assert.equal(await evaluate(rows),5);
    if(failure) assert.match(await evaluate("document.body.innerText"), failure==='500'?/temporarily unavailable/:/incomplete|stopped before/);
  }
  results.push("500/malformed/truncated recovery preserves five-item list; retry succeeds");
  await click('Save list'); await delay(300);
  const bookmark = '[aria-label="Save this basket"]';
  await evaluate(`document.querySelector(${JSON.stringify(bookmark)}).click()`); await delay(300);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('cartiva-local-library-v1')).baskets.length"),1);
  await evaluate("const c=[...document.querySelectorAll('button')].find(b=>/Add basket to Kroger/.test(b.textContent)); c.click(); c.click()");
  await until("document.body.innerText.includes('Your Kroger cart is ready')", "confirmed mock handoff");
  assert.equal(await evaluate("qa.calls.filter(c=>c.endsWith('/cart')).length"),1);
  assert.equal(await evaluate("document.querySelector('a[href=\"https://www.kroger.com/cart\"]')?.getAttribute('href')"),'https://www.kroger.com/cart');
  results.push("authenticated fixture transfer: one cart request for double click; exact cart link");
  await navigateWorkspace(Array.from({length:50},()=>"White bread").join('\n'));
  await click('Save list'); await delay(250);
  await send('Page.reload'); await delay(800);
  assert.equal(await evaluate(rows),50);
  results.push('50-row saved-list reload');
  await evaluate("window.qaOriginalSetItem=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')}");
  await input('input[aria-label="List name"]','Unsaved discovery changes'); await click('Save list'); await delay(250);
  assert.match(await evaluate('document.body.innerText'),/only in this open tab/);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Saved')"),false);
  await evaluate('Storage.prototype.setItem=window.qaOriginalSetItem'); await click('Retry saving'); await delay(250);
  assert.doesNotMatch(await evaluate('document.body.innerText'),/only in this open tab/);
  results.push('quota failure is honest; retry persists without discarding work');
  for(const width of [320,375,390,430,768,1024]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<768});
    await navigateWorkspace(five); await click('Compare basket');
    await until("document.querySelector('[aria-label=\"Save this basket\"]')", 'mobile result'); await delay(200);
    assert.equal(await evaluate('Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth'),false,`overflow at ${width}`);
    const containment = await evaluate(`(() => { const rows=document.querySelector('[aria-label="Kroger matched basket"]'); const subtotal=rows.nextElementSibling; return {height:rows.clientHeight,lastBottom:rows.lastElementChild.getBoundingClientRect().bottom,subtotalTop:subtotal.getBoundingClientRect().top,footerTop:document.querySelector('footer').getBoundingClientRect().top,comparisonBottom:document.querySelector('#compare').getBoundingClientRect().bottom}; })()`);
    assert(containment.height>=60, `basket content has no usable space at ${width}: ${JSON.stringify(containment)}`);
    if(width<=640) assert(containment.lastBottom<=containment.subtotalTop+1,`basket rows overlap subtotal at ${width}: ${JSON.stringify(containment)}`);
    assert(containment.comparisonBottom<=containment.footerTop+1,`comparison overlaps footer at ${width}`);
    await evaluate("const action=[...document.querySelectorAll('button')].find(b=>/Add basket to Kroger/.test(b.textContent)); action.focus(); action.scrollIntoView({block:'center'})");
    assert.equal(await evaluate("/Add basket to Kroger/.test(document.activeElement.textContent)"),true);
    if(width===390) {
      const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      writeFileSync(path.join(tmpdir(),'cartiva-discovery-mobile-results.png'),Buffer.from(capture.data,'base64'));
    }
  }
  results.push('five-item results at320/375/390/430/768/1024: horizontal and vertical containment; handoff focusable and scrollable');
  await evaluate('qa.feedback=true');
  await click('Compare again');
  await until("document.querySelectorAll('details').length>0 && document.body.innerText.includes('Product subtotal')",'feedback comparison');
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Choose & recheck')",'candidate recovery controls');
  await evaluate("document.querySelector('details').open=true");
  const beforeChoice=await evaluate('qa.lastSearch');
  await click('Choose & recheck');
  await until("qa.lastSearch.items[0].preferredProductId",'selection starts fresh comparison');
  const afterChoice=await evaluate('qa.lastSearch');
  assert.equal(afterChoice.locationId,beforeChoice.locationId);
  assert.equal(afterChoice.fulfillmentMode,beforeChoice.fulfillmentMode);
  assert.deepEqual(afterChoice.items.map(i=>[i.text,i.quantity]),beforeChoice.items.map(i=>[i.text,i.quantity]));
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='This matches'&&!b.disabled)",'fresh feedback');
  await evaluate("qa.feedbackFailure=true;document.querySelector('details').open=true");
  await click('This matches');
  await until("document.body.innerText.includes(\"Feedback wasn't saved\")",'truthful feedback failure');
  assert.equal(await evaluate('qa.lastSearch.items.length'),5);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'feedback overflows mobile');
  await evaluate('qa.feedbackFailure=false');
  await click('This matches');
  await until("document.body.innerText.includes('Feedback saved.')",'feedback success');
  results.push('candidate choice rechecks with original list/quantity/store; failed feedback preserves basket; compact feedback fits mobile');
  await send('Runtime.evaluate',{expression:"window.qaPopup=window.open('http://127.0.0.1:9242/','cartiva-policy-test','popup,width=560,height=760')",userGesture:true});
  await delay(400);
  assert.equal(await evaluate('!!window.qaPopup && !window.qaPopup.closed'),true,'live cross-origin popup must not look cancelled');
  await evaluate('window.qaPopup.close()'); results.push('actual cross-origin popup survives Cartiva opener policy');
  // Cutover recovery: old blocked work has no new server-owner cookie. This
  // path must authorize only; it must never invoke the cart-writing endpoint.
  await evaluate(`(() => {
    const now=Date.now(); window.qa.connected=false; window.qa.reviewOwner=false;
    window.qa.legacyPending={version:1,intent:'shopper_transfer',operationId:'legacy-blocked-operation-12345',locationId:'03500529',fulfillmentMode:'pickup',items:[{upc:'0001111012000',quantity:1}],itemCount:1,createdAt:now,submittedAt:now,blocked:{code:'outcome_unknown',message:'Review interrupted retailer transfer.',blockedAt:now}};
    localStorage.setItem('cartiva-kroger-pending-cart-v1',JSON.stringify(window.qa.legacyPending));
  })()`);
  await evaluate("[...document.querySelectorAll('button')].find(b=>/Add basket to Kroger/.test(b.textContent)).click()");
  await click('Items were not added');
  await until("document.body.innerText.includes('Reconnect to review')",'legacy ownerless review recovery');
  const writesBefore=await evaluate("qa.calls.filter(c=>c.endsWith('/cart')).length");
  await send('Runtime.evaluate',{expression:"[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reconnect to review').click()",userGesture:true});
  await until("document.body.innerText.includes('No items were sent')",'authentication-only recovery',15000);
  assert.equal(await evaluate("qa.calls.filter(c=>c.endsWith('/cart')).length"),writesBefore);
  assert(await evaluate("!!localStorage.getItem('cartiva-kroger-pending-cart-v1')"));
  await evaluate('qa.reviewFailure=true'); await click('Items were not added');
  await until("document.body.innerText.includes('Review storage unavailable')",'failed acknowledgement retains work');
  assert(await evaluate("!!localStorage.getItem('cartiva-kroger-pending-cart-v1')"));
  await evaluate("qa.reviewFailure=false; qa.newerPending={...qa.legacyPending,operationId:'newer-other-tab-operation-12345'}");
  await click('Items were not added'); await delay(300);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('cartiva-kroger-pending-cart-v1')).operationId"),'newer-other-tab-operation-12345');
  assert.equal(await evaluate("qa.calls.filter(c=>c.endsWith('/cart')).length"),writesBefore);
  results.push('ownerless legacy review reconnects without transfer; failed review retains work; late acknowledgement preserves newer tab marker');
  const output={target,results,passed:results.length,profile};
  const reportPath=path.join(tmpdir(),'cartiva-discovery-browser-results.json'); writeFileSync(reportPath,JSON.stringify(output,null,2));
  console.log(JSON.stringify({...output,reportPath},null,2));
} finally { socket?.close(); chrome.kill(); retailer.close(); }
