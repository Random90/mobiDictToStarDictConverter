#!/usr/bin/env python3
"""
Verify the reversed-suffix label decoding algorithm for INFL form entries.
"""
import struct

MOBI_FILE = '/home/random9/Downloads/SJP2-202507140955.mobi'

def getVWI(data, offset):
    v=0; c=0; f=False
    while not f:
        b=data[offset+c]; c+=1
        if b&0x80: f=True
        v=(v<<7)|(b&0x7f)
    return c,v

def readTagx(data, start):
    if data[start:start+4]!=b'TAGX': return 0,[]
    fe,=struct.unpack_from(b'>L',data,start+4)
    cbc,=struct.unpack_from(b'>L',data,start+8)
    tags=[]
    for i in range(12,fe,4):
        p=start+i
        tags.append((data[p],data[p+1],data[p+2],data[p+3]))
    return cbc,tags

def getTagMap(cbc,tt,ed,sp,ep):
    thm={}; cbi=0; ds=sp+cbc; tmp=[]
    for tag,vpe,mask,ef in tt:
        if ef==1: cbi+=1; continue
        cb=ed[sp+cbi]; val=cb&mask
        if val:
            if val==mask:
                if bin(mask).count('1')>1:
                    c,val=getVWI(ed,ds); ds+=c; tmp.append((tag,None,val,vpe))
                else: tmp.append((tag,1,None,vpe))
            else:
                m=mask
                while m&1==0: m>>=1; val>>=1
                tmp.append((tag,val,None,vpe))
    for tag,vc,vb,vpe in tmp:
        vals=[]
        if vc is not None:
            for _ in range(vc*vpe):
                c,v=getVWI(ed,ds); ds+=c; vals.append(v)
        else:
            tot=0
            while tot<vb:
                c,v=getVWI(ed,ds); ds+=c; tot+=c; vals.append(v)
        thm[tag]=vals
    return thm

raw=open(MOBI_FILE,'rb').read()
n=struct.unpack('>H',raw[76:78])[0]
recs=[struct.unpack('>I',raw[78+i*8:82+i*8])[0] for i in range(n)]+[len(raw)]
def load(i): return raw[recs[i]:recs[i+1]]
def parseHdr(data):
    kw=('len','nul1','type','gen','start','count','code','lng','total','ordt','ligt','nligt','nctoc')
    return dict(zip(kw,struct.unpack('>13L',data[4:4*14])))
def getORDT(ctrl,hdr):
    ocnt,oentries,op1,op2,otagx=struct.unpack_from(b'>LLLLL',ctrl,0xa4)
    if (hdr['code']==0xfdea or ocnt) and oentries>0:
        if ctrl[op1:op1+4]==b'ORDT' and ctrl[op2:op2+4]==b'ORDT':
            return struct.unpack_from(f'>{oentries}H',ctrl,op2+4)
    return None
def decodeKey(rb, o2):
    if o2 is None: return rb.decode('utf-8','replace')
    return ''.join(chr(o2[b]) if b<len(o2) else chr(b) for b in rb)

def parseInflLabel(label_bytes):
    """
    Parse INFL form entry label.
    Returns list of (form_suffix, canonical_suffix) pairs.
    Returns empty list if not a Type B (suffix-based) label.
    """
    if not label_bytes or label_bytes[0] == 0x01:
        return []  # Type A (grammar/metadata), skip

    results = []
    form_suffix_bytes = None
    canonical_suffix_bytes = None

    i = 0
    while i < len(label_bytes):
        marker = label_bytes[i]
        i += 1
        # Read until next control byte (< 0x20) or end
        start = i
        while i < len(label_bytes) and label_bytes[i] >= 0x20:
            i += 1
        chunk = label_bytes[start:i]

        if marker == 0x02:
            form_suffix_bytes = chunk
        elif marker == 0x03:
            canonical_suffix_bytes = chunk
        # 0x0c and other markers: skip for now

    if form_suffix_bytes is not None:
        form_suffix = bytes(reversed(form_suffix_bytes)).decode('utf-8', 'replace')
        canonical_suffix = bytes(reversed(canonical_suffix_bytes)).decode('utf-8', 'replace') if canonical_suffix_bytes else ''
        results.append((form_suffix, canonical_suffix))

    return results

def deriveForm(canonical, form_suffix, canonical_suffix):
    if canonical_suffix and canonical.endswith(canonical_suffix):
        stem = canonical[:-len(canonical_suffix)]
        return stem + form_suffix
    elif not canonical_suffix:
        return canonical + form_suffix
    return None

# Load ORTH
print("Loading ORTH index...")
orth_ctrl=load(53129); oh=parseHdr(orth_ctrl); o2=getORDT(orth_ctrl,oh)
cbc_orth,tt_orth=readTagx(orth_ctrl, oh['len'])
orth_words=[]; orth_tag42={}
for rec_num in range(53130, 53203):
    od=load(rec_num)
    dh=dict(zip(('len','nul1','type','gen','start','count'),struct.unpack('>6L',od[4:4*7])))
    idxtPos=dh['start']; ec=dh['count']
    idxPos=[struct.unpack_from(b'>H',od,idxtPos+4+2*j)[0] for j in range(ec)]+[idxtPos]
    for j in range(ec):
        sp=idxPos[j]; ep=idxPos[j+1]
        tl=od[sp]; text=od[sp+1:sp+1+tl]
        word=decodeKey(text,o2)
        tags=getTagMap(cbc_orth,tt_orth,od,sp+1+tl,ep)
        orth_words.append(word)
        if 42 in tags: orth_tag42[len(orth_words)-1]=tags[42][0]
print(f"ORTH: {len(orth_words)} entries, {len(orth_tag42)} with tag42")

# Build groupHeadwords
groupHeadwords = {}
for orth_ord, g in orth_tag42.items():
    if g not in groupHeadwords: groupHeadwords[g] = []
    groupHeadwords[g].append((orth_ord, orth_words[orth_ord]))
# Sort by ordinal within each group
for g in groupHeadwords:
    groupHeadwords[g].sort()

# Load INFL entries
print("Loading INFL index...")
infl_ctrl=load(53203); ih=parseHdr(infl_ctrl)
cbc_infl,tt_infl=readTagx(infl_ctrl, ih['len'])
all_infl = []
for rec_num in range(53204, 53240):
    id_=load(rec_num)
    dh=dict(zip(('len','nul1','type','gen','start','count'),struct.unpack('>6L',id_[4:4*7])))
    idxtPos=dh['start']; ec=dh['count']
    idxPos=[struct.unpack_from(b'>H',id_,idxtPos+4+2*j)[0] for j in range(ec)]+[idxtPos]
    for j in range(ec):
        sp=idxPos[j]; ep=idxPos[j+1]
        tl=id_[sp]
        label=id_[sp+1:sp+1+tl]
        tags=getTagMap(cbc_infl,tt_infl,id_,sp+1+tl,ep)
        all_infl.append((label, tags))
print(f"INFL: {len(all_infl)} entries")

# === Test with pies ===
pies_ord = next((i for i,w in enumerate(orth_words) if w=='pies'), None)
pies_group = orth_tag42.get(pies_ord)
print(f"\npies: ORTH[{pies_ord}], group={pies_group}")
print(f"Group {pies_group} headwords: {groupHeadwords.get(pies_group, [])}")

# Get INFL template for pies group
template_label, template_tags = all_infl[pies_group]
t26 = template_tags.get(26, [])
print(f"\nINFL[{pies_group}].tag26 = {t26}")
print(f"\nDeriving forms for all headwords in group {pies_group}:")
for form_ord in t26:
    if form_ord < len(all_infl):
        form_label, form_tags = all_infl[form_ord]
        parsed = parseInflLabel(form_label)
        if parsed:
            for form_suffix, canonical_suffix in parsed:
                print(f"\n  INFL[{form_ord}] label={form_label.hex()!r}")
                print(f"    form_suffix={form_suffix!r}, canonical_suffix={canonical_suffix!r}")
                for orth_i, canonical in groupHeadwords.get(pies_group, []):
                    form = deriveForm(canonical, form_suffix, canonical_suffix)
                    if form:
                        print(f"    {canonical!r} → {form!r}")
        else:
            print(f"\n  INFL[{form_ord}] (no parse): {form_label.hex()!r} = {form_label.decode('ascii','replace')!r}")

# === Full extraction run ===
print("\n\n=== Full extraction (all paradigm groups 1-8006) ===")
inflMap = {}
skipped_nogroup = 0
skipped_noparse = 0
skipped_nomatch = 0
total_processed = 0

for g in range(1, 8007):
    headwords = groupHeadwords.get(g, [])
    if not headwords:
        skipped_nogroup += 1
        continue
    template_label, template_tags = all_infl[g]
    t26 = template_tags.get(26, [])

    for form_ord in t26:
        if form_ord >= len(all_infl): continue
        form_label, form_tags = all_infl[form_ord]
        parsed = parseInflLabel(form_label)
        if not parsed:
            skipped_noparse += 1
            continue

        total_processed += 1
        for form_suffix, canonical_suffix in parsed:
            for orth_i, canonical in headwords:
                form = deriveForm(canonical, form_suffix, canonical_suffix)
                if form and form != canonical:
                    inflMap[form] = canonical

print(f"Groups processed: {8006 - skipped_nogroup}")
print(f"Form entries skipped (no parse): {skipped_noparse}")
print(f"Form entries processed: {total_processed}")
print(f"Total inflected forms mapped: {len(inflMap)}")

# Sample outputs
print(f"\nSample mappings (first 20):")
for k, v in list(inflMap.items())[:20]:
    print(f"  {k!r} → {v!r}")

# Check pies-specific forms
print(f"\nForms mapping TO 'pies':")
pies_forms = [(k,v) for k,v in inflMap.items() if v == 'pies']
for k, v in sorted(pies_forms):
    print(f"  {k!r} → {v!r}")

# Check forms mapping to arcypies and kunopies
print(f"\nForms mapping TO 'arcypies':")
for k,v in sorted([(k,v) for k,v in inflMap.items() if v=='arcypies']):
    print(f"  {k!r}")
print(f"\nForms mapping TO 'kunopies':")
for k,v in sorted([(k,v) for k,v in inflMap.items() if v=='kunopies']):
    print(f"  {k!r}")

# Check for another test case - 'kot' (cat)
kot_ord = next((i for i,w in enumerate(orth_words) if w=='kot'), None)
if kot_ord:
    kot_group = orth_tag42.get(kot_ord)
    print(f"\n\nTest: 'kot' at ORTH[{kot_ord}], group={kot_group}")
    print(f"Forms mapping TO 'kot':")
    for k,v in sorted([(k,v) for k,v in inflMap.items() if v=='kot']):
        print(f"  {k!r}")

# Check for 'dom' (house)
dom_ord = next((i for i,w in enumerate(orth_words) if w=='dom'), None)
if dom_ord:
    dom_group = orth_tag42.get(dom_ord)
    print(f"\nTest: 'dom' at ORTH[{dom_ord}], group={dom_group}")
    print(f"Forms mapping TO 'dom':")
    for k,v in sorted([(k,v) for k,v in inflMap.items() if v=='dom']):
        print(f"  {k!r}")

print("\nDone.")

