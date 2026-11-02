# End-to-end Mail test against scripts/fake-gmail.js. Prints PASS/FAIL per rule.
B=http://localhost:${API_PORT:-4200}/api
F=http://localhost:4900
fails=0
j() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval(process.argv[1]))})" "$1"; }
call() { curl -s -X "$1" "$B$2" -H "authorization: Bearer $3" -H 'content-type: application/json' ${4:+-d "$4"}; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$B$2" -H "authorization: Bearer $3" -H 'content-type: application/json' ${4:+-d "$4"}; }
login() { curl -s $B/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"Start-1234\"}" | j 'o.token'; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: expected [$3] got [$2]"; fails=$((fails+1)); fi; }

S=$(login boss@firm.test)
mk() { call POST /users "$S" "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"Start-1234\",\"role\":\"$3\"}" | j 'o._id'; }
H=$(mk Hitesh hitesh@firm.test admin); O=$(mk OtherTL other@firm.test admin); A=$(mk Ayush ayush@firm.test employee); N=$(mk Neha neha@firm.test employee)
T=$(call POST /teams "$S" "{\"name\":\"Team Hitesh\",\"leadId\":\"$H\"}" | j 'o._id')
T2=$(call POST /teams "$S" "{\"name\":\"Team Other\",\"leadId\":\"$O\"}" | j 'o._id')
call POST /teams/$T/members "$S" "{\"userId\":\"$A\"}" >/dev/null; call POST /teams/$T/members "$S" "{\"userId\":\"$N\"}" >/dev/null
C=$(call POST /clients "$S" "{\"name\":\"Hamilton\",\"teamIds\":[\"$T\"]}" | j 'o._id')
C2=$(call POST /clients "$S" "{\"name\":\"Other Co\",\"teamIds\":[\"$T2\"]}" | j 'o._id')
check "public domain rule refused" "$(code PATCH /clients/$C "$S" '{"emailMatches":["gmail.com"]}')" 400
call PATCH /clients/$C "$S" '{"emailMatches":["hamilton.example"]}' >/dev/null
call POST /clients/$C/permissions "$S" "{\"userId\":\"$A\"}" >/dev/null

URL=$(call POST /mail/accounts/connect "$S" "{\"team\":\"$T\"}" | j 'o.url')
check "staff cannot connect inbox" "$(code POST /mail/accounts/connect "$(login ayush@firm.test)" '{}')" 403
curl -s -L -o /dev/null "$URL"; sleep 2
AC=$(call GET /mail/accounts "$S" | j 'o.accounts[0]._id')
curl -s -o /dev/null -w '' "$B/mail/oauth/callback?code=x&state=forged"
call POST /mail/accounts/$AC/sync "$S" >/dev/null
HT=$(login hitesh@firm.test); AT=$(login ayush@firm.test); NT=$(login neha@firm.test); OT=$(login other@firm.test)
check "token not exposed" "$(call GET /mail/accounts "$S" | j 'String(o.accounts[0].refreshToken)')" undefined
check "owner sees 2, spam dropped" "$(call GET /mail/threads "$S" | j 'o.length')" 2
TH=$(call GET '/mail/threads?q=bank' "$S" | j 'o[0]._id')
U=$(call GET '/mail/threads?q=Quote' "$S" | j 'o[0]._id')
check "auto-tagged by domain" "$(call GET /mail/threads/$TH "$S" | j 'o.client.name+":"+o.tagSource')" "Hamilton:auto"
check "untagged stays untagged" "$(call GET /mail/threads/$U "$S" | j 'String(o.client)')" null
check "staff with access sees tagged only" "$(call GET /mail/threads "$AT" | j 'o.map(t=>t.subject).join()')" "October bank statement"
check "team member without client access sees none" "$(call GET /mail/threads "$NT" | j 'o.length')" 0
check "staff without access blocked from opening" "$(code GET /mail/threads/$TH "$NT")" 404
check "other TL sees none" "$(call GET /mail/threads "$OT" | j 'o.length')" 0
check "inbox TL sees tagged + untagged" "$(call GET /mail/threads "$HT" | j 'o.length')" 2
check "staff cannot tag to a client they lack" "$(code PATCH /mail/threads/$TH "$AT" "{\"client\":\"$C2\"}")" 403
check "cannot assign to person without access" "$(code PATCH /mail/threads/$TH "$AT" "{\"assignee\":\"$N\"}")" 400
check "staff assigns colleague with access" "$(code PATCH /mail/threads/$TH "$AT" "{\"assignee\":\"$A\"}")" 200
check "comment" "$(code POST /mail/threads/$TH/comments "$AT" '{"text":"on it"}')" 201
check "email to task" "$(call POST /mail/threads/$TH/task "$AT" '{}' | j 'o.title')" "October bank statement"
check "cannot reply when untagged" "$(code POST /mail/threads/$U/replies "$HT" '{"body":"hi"}')" 400

# Review flow
check "staff reply goes to review" "$(call POST /mail/threads/$TH/replies "$AT" '{"body":"Draft one"}' | j 'o.status')" pending
check "nothing sent before approval" "$(curl -s $F/sent | j 'o.length')" 0
R=$(call GET /mail/reviews "$HT" | j 'o[0]._id')
check "staff cannot approve" "$(code POST /mail/replies/$R/approve "$AT" '{}')" 403
check "other TL cannot approve" "$(code POST /mail/replies/$R/approve "$OT" '{}')" 403
check "send back needs note" "$(code POST /mail/replies/$R/send-back "$HT" '{}')" 400
check "send back" "$(call POST /mail/replies/$R/send-back "$HT" '{"note":"Be more polite"}' | j 'o.status')" sent_back
check "another user cannot resubmit" "$(code PATCH /mail/replies/$R "$NT" '{"body":"x"}')" 404
check "author resubmits" "$(call PATCH /mail/replies/$R "$AT" '{"body":"Draft two, thank you"}' | j 'o.status')" pending
check "TL approves with edit" "$(call POST /mail/replies/$R/approve "$HT" '{"body":"Final, received, thank you"}' | j 'o.status')" sent
check "double approve refused" "$(code POST /mail/replies/$R/approve "$HT" '{}')" 409
check "sent to client, in thread" "$(curl -s $F/sent | j 'o.length+"|"+o[0].to+"|"+o[0].threadId.length+"|"+o[0].text+"|"+o[0].inReplyTo')" "1|J. Hamilton <accounts@hamilton.example>|2|Final, received, thank you|<m1@fake>"
check "TL reply sends directly" "$(call POST /mail/threads/$TH/replies "$HT" '{"body":"Direct"}' | j 'o.status')" sent
call POST /mail/accounts/$AC/sync "$S" >/dev/null
check "sync does not duplicate sent mail" "$(call GET /mail/threads/$TH "$S" | j 'o.messages.length')" 3

# New mail
call PATCH /mail/threads/$TH "$AT" '{"status":"done"}' >/dev/null
TID=$(curl -s $F/sent | j 'o[0].threadId')
curl -s -X POST $F/add-mail -H 'content-type: application/json' -d "{\"from\":\"accounts@hamilton.example\",\"subject\":\"Re: October bank statement\",\"text\":\"Thanks\",\"threadId\":\"$TID\"}" >/dev/null
call POST /mail/accounts/$AC/sync "$S" >/dev/null
check "new client email reopens" "$(call GET /mail/threads/$TH "$S" | j 'o.status+o.messages.length')" open4
curl -s -X POST $F/add-mail -H 'content-type: application/json' -d '{"from":"a@later.example","subject":"Later client","text":"hi"}' >/dev/null
call POST /mail/accounts/$AC/sync "$S" >/dev/null
call PATCH /clients/$C2 "$S" '{"emailMatches":["later.example"]}' >/dev/null
check "adding a rule tags old mail" "$(call GET '/mail/threads?q=Later' "$S" | j 'o[0].client.name')" "Other Co"
curl -s -X POST $F/add-mail -H 'content-type: application/json' -d '{"from":"<img src=x onerror=alert(1)>@x.example","subject":"<b>x</b>","text":"<script>alert(1)</script>"}' >/dev/null
echo "failures: $fails"
