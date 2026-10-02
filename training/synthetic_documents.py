"""Deterministic, explicitly fictional starter documents, never real-world evidence.

Ten hand-written content templates per class vary narrative structure as well as
field values. All templates and records share one generator and vocabulary, so a
held-out family is still synthetic development data, not an independent benchmark.
Every category in the same family shares a group_id to prevent layout-family
leakage. Rendered/modified copies must retain that group_id and document_id.

Amounts are computed in integer minor currency units. Marks, meter readings,
parcel dimensions, dates, invoice totals, and bank balances are computed rather
than independently invented. Medication examples intentionally exclude real
medicine names, dosages, diagnoses, and clinical instructions. No real identifiers,
signatures, personal contacts, payment addresses, or official seals are created.
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Iterator
from datetime import date, timedelta

DISCLAIMER = (
    "SYNTHETIC TRAINING EXAMPLE. All people, organizations, references and events "
    "are fictional. Not valid for official, financial or medical use."
)

CATEGORIES = {
    "marksheet": "education",
    "educational_certificate": "education",
    "utility_bill": "bills_payments",
    "invoice": "bills_payments",
    "receipt": "bills_payments",
    "land_record": "property_land",
    "bank_statement": "banking",
    "prescription": "medical",
}

PLACES = ("North", "South", "East", "West", "Central", "Riverside", "Hill", "Lake")
SUBJECT_SETS = (
    ("English", "Mathematics", "Science", "History", "Geography"),
    ("Accounting", "Economics", "Business Studies", "English", "Statistics"),
    ("Programming", "Databases", "Networks", "Mathematics", "Communication"),
    ("Literature", "History", "Political Studies", "Sociology", "English"),
)
GOODS = (
    "notebook packs", "desk organizers", "printed booklets", "storage boxes",
    "replacement cables", "drawing sheets", "maintenance visits", "design sessions",
)
COURSES = (
    "Business Communication", "Introductory Computing", "Bookkeeping Fundamentals",
    "Environmental Studies", "Digital Design", "Library Practice", "Office Administration",
    "Food Service Basics", "Applied Statistics", "Community Research",
)


def _money(paise: int) -> str:
    sign = "-" if paise < 0 else ""
    value = abs(paise)
    return f"{sign}INR {value // 100:,}.{value % 100:02d}"


def _day(value: date) -> str:
    return value.strftime("%d %B %Y")


def _base(rng: random.Random) -> dict[str, str]:
    issued = date(2023, 1, 1) + timedelta(days=rng.randrange(900))
    return {
        "person": f"Sample Person {rng.randrange(10000, 99999)}",
        "organization": f"Sample {rng.choice(PLACES)} Organization",
        "place": f"Sample {rng.choice(PLACES)} District",
        "reference": f"EXAMPLE-VOID-{rng.randrange(100000, 999999)}",
        "date": _day(issued),
        "start": _day(issued - timedelta(days=30)),
        "end": _day(issued - timedelta(days=1)),
        "due": _day(issued + timedelta(days=15)),
    }


def _marksheet(rng: random.Random, context: dict[str, str]) -> None:
    subjects = rng.choice(SUBJECT_SETS)
    marks = [rng.randint(28, 99) for _ in subjects]
    total = sum(marks)
    maximum = 100 * len(subjects)
    passed = all(mark >= 40 for mark in marks)
    result = "Pass" if passed else "Reassessment required"
    rows = ["Subject | Maximum marks | Obtained marks | Subject result"]
    rows += [
        f"{subject} | 100 | {mark} | {'Pass' if mark >= 40 else 'Reassessment required'}"
        for subject, mark in zip(subjects, marks)
    ]
    context.update(
        institution=f"{context['organization']} Learning Centre",
        program=rng.choice(("Secondary Programme", "Foundation Programme", "Diploma Term")),
        term=rng.choice(("Term One", "Term Two", "Final Assessment")),
        marks="\n".join(rows),
        total=str(total),
        maximum=str(maximum),
        percent=f"{100 * total / maximum:.2f}%",
        result=result,
        rule="For this fictional assessment, each subject requires at least 40 out of 100.",
    )


def _certificate(rng: random.Random, context: dict[str, str]) -> None:
    context.update(
        institution=f"{context['organization']} Learning Centre",
        course=rng.choice(COURSES),
        hours=str(rng.choice((24, 40, 60, 80, 120, 180))),
        mode=rng.choice(("classroom workshops", "supervised practical sessions", "blended sessions")),
        award=rng.choice(("Certificate of Completion", "Foundation Certificate", "Course Award")),
        components=rng.choice((
            "guided exercises, a final project, and a completion review",
            "workshops, a practical portfolio, and a closing presentation",
            "learning activities, supervised practice, and an end-of-course review",
        )),
    )


def _utility(rng: random.Random, context: dict[str, str]) -> None:
    service, unit, rate = rng.choice((
        ("electricity", "kWh", 625), ("water", "cubic metres", 1850),
        ("piped gas", "cubic metres", 4300),
    ))
    previous = rng.randint(100, 8000)
    used = rng.randint(12, 180)
    fixed = rng.randint(30, 150) * 100
    usage = used * rate
    arrears = rng.choice((0, 0, 5000, 12500))
    credit = rng.choice((0, 0, 2000))
    payable = usage + fixed + arrears - credit
    context.update(
        provider=f"{context['organization']} Utility Services",
        service=service,
        unit=unit,
        previous=str(previous),
        current=str(previous + used),
        usage=str(used),
        rate=_money(rate),
        usage_charge=_money(usage),
        fixed_charge=_money(fixed),
        arrears=_money(arrears),
        credit=_money(credit),
        total=_money(payable),
        meter=f"EXAMPLE-VOID-METER-{rng.randrange(1000, 9999)}",
        address=f"Sample Premises {rng.randrange(1, 500)}, {context['place']}",
    )


def _invoice(rng: random.Random, context: dict[str, str]) -> None:
    goods = rng.sample(GOODS, 3)
    rows = ["Item or service | Quantity | Unit price | Line amount"]
    subtotal = 0
    for item in goods:
        quantity = rng.randint(1, 12)
        price = rng.randint(50, 750) * 100
        amount = quantity * price
        subtotal += amount
        rows.append(f"{item} | {quantity} | {_money(price)} | {_money(amount)}")
    discount_percent = rng.choice((0, 5, 10))
    discount = subtotal * discount_percent // 100
    net = subtotal - discount
    tax = (net + 5) // 10  # 10%, rounded to the nearest paise; ties round upward.
    context.update(
        seller=f"{context['organization']} Supplies",
        buyer=f"Sample {rng.choice(PLACES)} Office",
        items="\n".join(rows),
        subtotal=_money(subtotal),
        discount_percent=str(discount_percent),
        discount=_money(discount),
        net=_money(net),
        tax=_money(tax),
        total=_money(net + tax),
        order=f"EXAMPLE-VOID-ORDER-{rng.randrange(1000, 9999)}",
    )


def _receipt(rng: random.Random, context: dict[str, str]) -> None:
    purpose = rng.choice((
        "stationery purchase", "course enrollment fee", "water service bill",
        "electricity service bill", "equipment repair", "book purchase",
        "workshop registration", "property document copy fee",
    ))
    amount = rng.randint(100, 10000) * 100
    method = rng.choice(("cash", "fictional card transaction", "fictional account transfer"))
    change = rng.choice((0, 5000, 10000)) if method == "cash" else 0
    context.update(
        receiver=f"{context['organization']} Collection Desk",
        purpose=purpose,
        amount=_money(amount),
        tendered=_money(amount + change),
        change=_money(change),
        method=method,
        linked_ref=f"EXAMPLE-VOID-{rng.randrange(100000, 999999)}",
        outstanding=_money(0),
    )


def _land(rng: random.Random, context: dict[str, str]) -> None:
    width = rng.randint(15, 80)
    depth = rng.randint(20, 100)
    context.update(
        office=f"{context['organization']} Sample Records Desk",
        parcel=f"EXAMPLE-VOID-PARCEL-{rng.randrange(1000, 9999)}",
        block=f"Sample Block {rng.randrange(1, 25)}",
        width=str(width),
        depth=str(depth),
        area=f"{width * depth:,}",
        land_use=rng.choice(("orchard", "cultivation", "residential plot", "vacant land")),
        north="Sample Access Lane",
        south=f"Sample Adjacent Plot {rng.randrange(100, 200)}",
        east="Sample Drainage Strip",
        west=f"Sample Adjacent Plot {rng.randrange(200, 300)}",
        note=rng.choice((
            "The rectangular sketch is a generated simplification; no actual survey was performed.",
            "The area is calculated from fictional rectangular dimensions, not a cadastral survey.",
            "The illustrated boundaries are invented and refer to no actual parcel.",
        )),
    )


def _bank(rng: random.Random, context: dict[str, str]) -> None:
    opening = rng.randint(10000, 50000) * 100
    balance = opening
    deposits = 0
    withdrawals = 0
    rows = ["Date | Description | Debit | Credit | Running balance"]
    anchor = date(2023, 1, 1) + timedelta(days=rng.randrange(800))
    credit_names = ("Sample incoming transfer", "Sample refund", "Sample salary credit")
    debit_names = ("Sample utility payment", "Sample purchase", "Sample cash withdrawal")
    for index in range(6):
        posted = _day(anchor + timedelta(days=3 + index * 4))
        if index % 3 == 0:
            amount = rng.randint(1000, 15000) * 100
            deposits += amount
            balance += amount
            debit, credit = _money(0), _money(amount)
            description = rng.choice(credit_names)
        else:
            amount = rng.randint(100, min(3000, balance // 200)) * 100
            withdrawals += amount
            balance -= amount
            debit, credit = _money(amount), _money(0)
            description = rng.choice(debit_names)
        rows.append(f"{posted} | {description} | {debit} | {credit} | {_money(balance)}")
    context.update(
        bank=f"{context['organization']} Fictional Bank",
        account=f"EXAMPLE-VOID-ACCOUNT-{rng.randrange(1000, 9999)}",
        start=_day(anchor),
        end=_day(anchor + timedelta(days=29)),
        date=_day(anchor + timedelta(days=30)),
        transactions="\n".join(rows),
        opening=_money(opening),
        deposits=_money(deposits),
        withdrawals=_money(withdrawals),
        closing=_money(balance),
    )


def _prescription(rng: random.Random, context: dict[str, str]) -> None:
    count = rng.choice((1, 2, 3))
    entries = [
        f"Entry {index + 1}: Fictional Medicine {letter}; dose, route, frequency and duration omitted."
        for index, letter in enumerate(rng.sample(("A", "B", "C", "D", "E", "F"), count))
    ]
    context.update(
        clinic=f"{context['organization']} Sample Clinic",
        clinician=f"Sample Clinician {rng.randrange(1000, 9999)}",
        medicines="\n".join(entries),
        count=str(count),
        encounter=rng.choice(("outpatient encounter", "follow-up encounter", "clinic encounter")),
    )


# Template family indices are global: shared styles across labels stay together.
# Repeated semantic fields are intentional, but no label string is added as a target hint.
TEMPLATES: dict[str, tuple[str, ...]] = {
    "marksheet": (
        """STATEMENT OF MARKS
{institution}
Student: {person}; programme: {program}; examination: {term}.
Result reference: {reference}; issued: {date}.
{marks}
Total obtained: {total} / {maximum}. Aggregate: {percent}.
Overall outcome: {result}. {rule}
This statement records subject performance; no attendance or fee information is included.""",
        """ASSESSMENT RESULTS MEMORANDUM
To: {person}
From: Assessment Section, {institution}
Date: {date}; file reference: {reference}
Your {term} assessments in the {program} are recorded below.
{marks}
The summed score is {total} against a possible {maximum}, giving {percent}.
The examination outcome is {result}. {rule}
Each row represents a separate assessed subject.""",
        """{institution} / {program} / {term}
Candidate {person} - statement {reference}
{marks}
SUMMARY | Obtained {total} | Possible {maximum} | Percentage {percent}
Result decision: {result}
Recorded on {date}. {rule}
Scores in this sheet describe assessment performance, rather than payment or course attendance.""",
        """EXAMINATION REGISTER EXTRACT
Entry reference {reference}, released {date}
Learner name: {person}
Awarding centre: {institution}; study stage: {program}; session: {term}
The result register contains the following subject entries:
{marks}
Aggregate register totals: {total} obtained, {maximum} available; {percent}.
Final result field: {result}.
Assessment rule attached to this extract: {rule}""",
        """Dear {person},
The assessment office of {institution} has prepared your {term} results for the
{program}. Your subject-level performance is reproduced here:
{marks}
Together these marks total {total} out of {maximum} ({percent}). Your result
status is {result}. {rule}
This result letter was prepared on {date}, reference {reference}.
Assessment Office""",
        """LEARNER RESULT CARD
Name: {person}
Centre: {institution}
Programme / session: {program} / {term}
Card ID: {reference}; publication date: {date}
{marks}
Obtained {total}; maximum {maximum}; aggregate {percent}; result {result}.
Scoring note: {rule}""",
        """Appendix A: subject performance schedule
Learner: {person}; institution: {institution}
Programme {program}, assessment window {term}, schedule {reference}.
The following marks support the published result dated {date}.
{marks}
Control total: {total} of {maximum}. Calculated percentage: {percent}.
The schedule records the outcome as {result}. {rule}
There are no unlisted subjects in the control total.""",
        """ACADEMIC PROGRESS SUMMARY
{institution} reviewed the {term} subject assessments for {person}, enrolled in
{program}. The review record is {reference}, dated {date}.
Subject detail:
{marks}
Across all listed subjects the learner earned {total} out of {maximum}, or
{percent}. The overall result is {result}.
Decision basis: {rule}""",
        """RESULT PUBLICATION NOTICE
Examination section: {institution}
The {term} results for candidate {person} ({program}) are now recorded under
reference {reference}. Publication date: {date}.
{marks}
Total score {total}/{maximum}; aggregate {percent}; outcome {result}.
Individual subject outcomes follow this rule: {rule}
This notice contains the full set of assessed subjects for this sample.""",
        """On {date}, {institution} issued an assessment statement for {person} in the
{program}, covering {term}. The statement is identified as {reference}.
Its subject results are:
{marks}
The obtained marks add to {total}; the maximum marks add to {maximum}. The
resulting aggregate is {percent}, and the recorded decision is {result}.
The decision follows the stated assessment convention: {rule}""",
    ),
    "educational_certificate": (
        """{award}
{institution}
This certifies that {person} completed {course} through {mode} between {start}
and {end}. The programme comprised {hours} scheduled learning hours and included
{components}.
The completion award was recorded on {date}; certificate reference {reference}.
This document attests completion and contains no subject marks or grade table.
Academic Records Office""",
        """COURSE COMPLETION MEMORANDUM
To: {person}; from: Programme Office, {institution}
Record {reference}, issued {date}.
We confirm completion of {course}, delivered by {mode} from {start} to {end}.
The course covered {hours} learning hours with {components}.
The recorded award is {award}. This memo is an educational completion attestation;
individual examination scores are not part of this record.""",
        """EDUCATIONAL AWARD REGISTER
Learner | {person}
Institution | {institution}
Qualification | {award} in {course}
Learning period | {start} to {end}
Scheduled hours | {hours}
Delivery | {mode}
Completion components | {components}
Award date | {date}
Certificate reference | {reference}
The register entry attests completion rather than itemized examination results.""",
        """QUALIFICATION ATTESTATION EXTRACT
The awards register of {institution} includes {person} under reference
{reference}. The learner completed {course} during {start} to {end}.
The programme consisted of {hours} learning hours using {mode}, incorporating
{components}.
Award entered: {award}. Entry recorded: {date}.
This extract describes the completed qualification; it is not a marks statement.""",
        """Dear {person},
We confirm that you have completed the {course} programme at {institution}.
Between {start} and {end}, the programme provided {hours} scheduled hours of
{mode}, including {components}.
Your {award} was entered in our sample records on {date}, reference {reference}.
This letter attests the completed course without reporting subject scores.
Programme Records Office""",
        """COURSE AWARD CARD
Recipient: {person}
Provider: {institution}
Award: {award}
Course: {course}
Period: {start} - {end}; hours: {hours}; delivery: {mode}
Completion evidence: {components}
Issued {date}; reference {reference}.
Purpose: confirmation of educational completion, without subject grades.""",
        """Annex: completion attestation
Award reference {reference}; issue date {date}.
This annex records that {person} fulfilled the completion components for
{course}: {components}.
The programme was delivered by {institution} through {mode}, with {hours}
scheduled hours between {start} and {end}.
The corresponding educational award is {award}. No assessment mark schedule is
attached to this sample attestation.""",
        """LEARNING COMPLETION SUMMARY
{institution} records completion of {course} by {person}. The learning period
ran from {start} to {end}, providing {hours} hours through {mode}.
Completion components: {components}.
The institution recorded a {award} on {date}, reference {reference}.
This summary confirms the award and course completion, rather than a set of
subject-by-subject exam results.""",
        """NOTICE OF EDUCATIONAL AWARD
Recipient {person}; records office {institution}.
Your completion of {course} has been entered as {award} on {date}.
The programme involved {hours} hours of {mode} during {start} to {end}, with
{components}.
Record identifier: {reference}.
This award notice confirms completion. It does not contain individual marks.""",
        """On {date}, the academic records office at {institution} recorded a {award}
for {person}. The award concerns {course}, completed between {start} and {end}.
Across {hours} scheduled learning hours, the learner participated in {mode}.
The programme's completion components comprised {components}.
The completion attestation bears reference {reference}. Its purpose is to
confirm the qualification, not to list examination marks.""",
    ),
    "utility_bill": (
        """{service} SERVICE BILL
Provider: {provider}; customer: {person}; premises: {address}
Bill reference {reference}; issued {date}; service period {start} to {end}.
Meter {meter}: previous reading {previous}, current reading {current}.
Usage {usage} {unit} at {rate} per {unit}: {usage_charge}.
Fixed service charge {fixed_charge}; brought-forward balance {arrears};
credit adjustment {credit}. Total payable: {total}. Due date: {due}.
Payment is outstanding. Rates in this fictional bill are illustrative.""",
        """SERVICE CHARGE MEMORANDUM
To {person} at {address}; from {provider}; reference {reference}.
During {start} to {end}, your {service} meter {meter} advanced from {previous}
to {current}. Consumption was {usage} {unit}, charged at {rate} per {unit}.
Usage charge {usage_charge} plus fixed charge {fixed_charge}, plus previous
balance {arrears}, less credit {credit}, gives {total} payable by {due}.
Issued {date}. This is a request for payment at fictional illustrative rates.""",
        """UTILITY ACCOUNT BILLING SCHEDULE
{provider}; {person}; {address}; period {start} - {end}
Service | {service}
Meter | {meter}
Readings | {previous} to {current}
Consumption | {usage} {unit}
Rate per {unit} | {rate}
Usage charge | {usage_charge}
Fixed charge | {fixed_charge}
Previous balance | {arrears}
Credit subtracted | {credit}
Amount due | {total}
Issued {date}; pay by {due}; reference {reference}.
Rates are illustrative; this bill does not acknowledge payment.""",
        """METERED SERVICE ACCOUNT EXTRACT
Account holder: {person}; supply location: {address}
{provider} issued record {reference} on {date} for {service}.
For the interval {start} to {end}, meter {meter} readings were {previous} and
{current}; the difference is {usage} {unit}. Illustrative unit rate: {rate}.
Billing entries: usage {usage_charge}; fixed service {fixed_charge}; prior
balance {arrears}; subtract credit {credit}.
Outstanding amount {total}, due {due}. Settlement is not recorded here.""",
        """Dear {person},
Your {service} bill from {provider} covers {start} through {end} at {address}.
Meter {meter} recorded {usage} {unit}, moving from {previous} to {current}.
At the illustrative rate of {rate} per {unit}, usage costs {usage_charge}.
Add {fixed_charge} fixed service and {arrears} previous balance, then subtract
the {credit} credit. The resulting amount due is {total}, payable by {due}.
Issued {date}; reference {reference}. This letter requests payment.""",
        """UTILITY BILL SUMMARY
{provider} | {service} | {person}
Premises: {address}; meter: {meter}
Period {start} - {end}; bill date {date}; reference {reference}
Readings {previous} -> {current}; consumed {usage} {unit}
Illustrative tariff {rate}/{unit}; usage charge {usage_charge}
Fixed {fixed_charge} + previous balance {arrears} - credit {credit}
PAYABLE {total}; DUE {due}; PAYMENT OUTSTANDING""",
        """Appendix: service billing calculation
Customer {person}, supply {address}, provider {provider}.
Bill {reference}, dated {date}, covers {service} from {start} to {end}.
Meter {meter}: closing reading {current} minus opening reading {previous}
equals {usage} {unit}. Multiplying by the illustrative {rate} unit rate gives
{usage_charge}. Add fixed service {fixed_charge} and prior balance {arrears};
deduct credit {credit}. The amount requested is {total}, due {due}.
This calculation accompanies an unpaid service bill.""",
        """HOUSEHOLD SERVICE BILLING REVIEW
For {person}, {provider} has calculated a {service} amount due of {total}.
The service address is {address}; the billing period is {start} to {end}.
Meter {meter} changed from {previous} to {current}, representing {usage}
{unit}. Illustrative rate {rate} gives a usage charge of {usage_charge}.
Other entries are fixed charge {fixed_charge}, previous balance {arrears},
and credit {credit}. Payment is requested by {due}.
Prepared {date}; bill reference {reference}. No payment is acknowledged.""",
        """NOTICE OF UTILITY AMOUNT DUE
{provider} requests {total} from {person} for {service} at {address}.
Reference {reference}; notice date {date}; due date {due}.
Service interval: {start} to {end}. Meter {meter}: {previous} to {current}.
Consumption {usage} {unit} at illustrative rate {rate} gives {usage_charge}.
Fixed service {fixed_charge}; previous balance {arrears}; less credit {credit}.
These entries make up the requested balance. This is a bill, not proof of payment.""",
        """The {service} bill issued by {provider} on {date} relates to {person} at
{address}. Its reference is {reference}, covering {start} to {end}.
The readings of meter {meter} rose from {previous} to {current}, a difference
of {usage} {unit}. Using an illustrative rate of {rate} per {unit}, the usage
charge is {usage_charge}. A fixed charge of {fixed_charge} and a prior balance
of {arrears} are added; a credit of {credit} is subtracted. The remaining
amount payable is {total}, with payment due on {due}.""",
    ),
    "invoice": (
        """INVOICE
Seller {seller}; billed to {buyer}; contact {person}.
Invoice reference {reference}; issued {date}; order {order}.
{items}
Subtotal {subtotal}; discount {discount_percent}% = {discount}; net {net}.
Illustrative training tax 10% of net: {tax}. Total amount due: {total}.
Payment due {due}; no payment has been recorded.
The tax rate is a fictional calculation convention, not a statement of tax law.""",
        """PAYMENT REQUEST MEMORANDUM
From {seller} to {buyer}, attention {person}.
Reference {reference}; date {date}; related order {order}.
The supplied goods or services are itemized below:
{items}
Their subtotal is {subtotal}. After {discount_percent}% discount ({discount}),
the net is {net}. Add illustrative training tax of 10%, {tax}, for {total} due
by {due}. This invoice remains unpaid. The sample tax convention is fictional.""",
        """SUPPLIER CHARGE SCHEDULE
{seller} -> {buyer}; recipient {person}
Document {reference}; order {order}; issued {date}
{items}
Subtotal | {subtotal}
Discount ({discount_percent}%) | {discount}
Net after discount | {net}
Fictional illustrative tax (10%) | {tax}
Invoice total | {total}
Settlement deadline {due}. Status: payment requested, not yet received.""",
        """SALES INVOICE REGISTER EXTRACT
Supplier {seller} records the following unpaid invoice to {buyer}, contact
{person}. Register reference {reference}; order {order}; invoice date {date}.
{items}
The line amounts sum to {subtotal}. Discount at {discount_percent}% is
{discount}, leaving net charges {net}. The fictional training tax is 10% of
net, or {tax}. The outstanding invoice total is {total}, payable by {due}.
No actual tax rule or payment endpoint is represented.""",
        """Dear {person},
{seller} submits this invoice to {buyer} for order {order}.
The itemized charges are:
{items}
Subtotal: {subtotal}. Discount: {discount_percent}% ({discount}). Net: {net}.
Illustrative fictional tax at 10% adds {tax}, bringing the requested payment
to {total}. Please note the due date {due}.
Invoice reference {reference}, issued {date}. Payment is outstanding.""",
        """INVOICE SUMMARY
Supplier {seller}; customer {buyer}; attention {person}
ID {reference}; order {order}; date {date}
{items}
Subtotal {subtotal} - discount {discount} ({discount_percent}%) = net {net}
Fictional 10% training tax {tax}; total payable {total}
Due {due}. This document requests payment; it is not a receipt.""",
        """Annex: itemized invoice calculation
Seller {seller}, buyer {buyer}, contact {person}.
Issued {date}, reference {reference}, order {order}.
{items}
Adding the extended line prices yields {subtotal}. A {discount_percent}%
discount removes {discount}, leaving {net}. Applying the fictional training
tax convention of 10% adds {tax}. The amount invoiced is therefore {total}.
This unpaid invoice falls due on {due}.""",
        """SUPPLIER ACCOUNT CHARGE SUMMARY
{buyer} owes {seller} {total} for the items in invoice {reference}, related to
order {order}. The customer contact is {person}; invoice date {date}.
{items}
Charges before adjustment: {subtotal}. Discount of {discount_percent}%:
{discount}. Net charges: {net}. Fictional illustrative tax of 10%: {tax}.
The resulting invoice is awaiting payment, with a due date of {due}.""",
        """NOTICE OF INVOICE DUE
To {buyer}, attention {person}; from {seller}.
An invoice for order {order} was issued on {date} under reference {reference}.
{items}
The subtotal {subtotal} is reduced by {discount_percent}% ({discount}) to
{net}. Fictional training tax at 10% is {tax}. Payment of the resulting
{total} is requested by {due}. This sample notice does not record settlement.""",
        """On {date}, {seller} invoiced {buyer}, with {person} listed as the contact,
for order {order}. The invoice carries reference {reference} and contains:
{items}
The line amounts total {subtotal}. A {discount_percent}% discount of
{discount} produces a net of {net}. An illustrative, fictional 10% tax adds
{tax}. Consequently {total} remains due, with payment requested by {due}.
This is an itemized request for payment rather than an acknowledgement.""",
    ),
    "receipt": (
        """PAYMENT RECEIPT
Issued by {receiver} to {person} on {date}.
Receipt reference {reference}; related charge {linked_ref}.
Payment purpose: {purpose}. Amount settled: {amount}.
Method: {method}. Amount tendered: {tendered}; change returned: {change}.
The payment was received in full. Remaining amount for this charge: {outstanding}.
This document acknowledges a completed payment; it does not request another one.""",
        """PAYMENT ACKNOWLEDGEMENT MEMORANDUM
To {person}; from {receiver}; dated {date}; reference {reference}.
We acknowledge receiving {amount} for {purpose}, related to {linked_ref}.
The recorded method is {method}. Tendered amount {tendered}, less returned
change {change}, equals the amount applied to the charge.
The remaining balance for this payment is {outstanding}. Settlement is complete.""",
        """COLLECTION RECEIPT REGISTER
Receiver | {receiver}
Payer | {person}
Date | {date}
Receipt reference | {reference}
Related charge | {linked_ref}
Reason | {purpose}
Payment method | {method}
Tendered | {tendered}
Change returned | {change}
Net received | {amount}
Remaining for this charge | {outstanding}
Status | Paid in full""",
        """CASHIER PAYMENT RECORD EXTRACT
{receiver} records completed payment from {person} on {date}.
Entry {reference} settles charge {linked_ref} for {purpose}.
The payer used {method}, tendering {tendered}. Change returned was {change};
the amount received and applied was {amount}.
The charge is fully settled with {outstanding} remaining.
This extract is proof of the fictional payment entry, not an unpaid invoice.""",
        """Dear {person},
{receiver} confirms receipt of your payment for {purpose} on {date}.
We received a net amount of {amount} by {method}; the tendered amount was
{tendered} and returned change was {change}.
Your payment settles reference {linked_ref}. The remaining charge balance is
{outstanding}. Retain acknowledgement {reference} with your sample records.
Collections Office""",
        """PAID RECEIPT
{receiver}; payer {person}; date {date}
Number {reference}; charge {linked_ref}
For: {purpose}
Method {method}; tendered {tendered}; change {change}
Net payment received {amount}; amount still owing {outstanding}
Settlement status: completed in full.""",
        """Appendix: completed payment allocation
Payer {person}; receiving desk {receiver}.
Receipt {reference}, dated {date}, applies to {linked_ref} ({purpose}).
Tendered funds: {tendered}. Less change returned: {change}. Net funds received:
{amount}. Method recorded: {method}.
All net funds were allocated to this charge, leaving {outstanding} outstanding.
This schedule accompanies an acknowledgement of payment already received.""",
        """SETTLEMENT CONFIRMATION
{person} has settled the {purpose} charge with {receiver}.
The completed payment on {date} is recorded as {reference}, linked to
{linked_ref}. Funds arrived by {method}: tendered {tendered}, change returned
{change}, net received {amount}.
The balance remaining on the charge is {outstanding}. This confirmation
acknowledges receipt and contains no new payment request.""",
        """NOTICE OF PAYMENT RECEIVED
{receiver} acknowledges {amount} received from {person} on {date} for
{purpose}. The receipt identifier is {reference}; original charge {linked_ref}.
Payment method: {method}. Tendered amount: {tendered}. Returned change: {change}.
The net payment fully settles the referenced charge, leaving {outstanding}.
This notice concerns a completed payment rather than an amount due.""",
        """A payment for {purpose} was received by {receiver} from {person} on {date}.
The payment used {method}, with {tendered} tendered and {change} returned as
change. The resulting {amount} was applied to charge {linked_ref}.
Receipt {reference} acknowledges the completed settlement. The charge has
{outstanding} remaining. No additional payment is requested by this record.""",
    ),
    "land_record": (
        """LAND PARCEL RECORD
Records desk {office}; extract {reference}; dated {date}.
Recorded holder: {person}. Parcel: {parcel}; locality: {block}, {place}.
Illustrative rectangular dimensions: {width} metres by {depth} metres.
Calculated area: {area} square metres. Recorded land use: {land_use}.
Boundaries: north {north}; south {south}; east {east}; west {west}.
{note} This sample conveys no title, ownership right, or legal certification.""",
        """PARCEL INFORMATION MEMORANDUM
To {person}; from {office}; date {date}; file {reference}.
The fictional parcel register lists {parcel} in {block}, {place}, with you as
the recorded holder. Land use is {land_use}. Dimensions {width} metres by
{depth} metres produce an illustrative area of {area} square metres.
The north edge meets {north}, south {south}, east {east}, and west {west}.
{note} This memorandum does not establish legal title.""",
        """PARCEL REGISTER SCHEDULE
Desk | {office}
Reference and date | {reference}; {date}
Parcel | {parcel}
Recorded holder | {person}
Location | {block}, {place}
Use | {land_use}
Width and depth | {width} m by {depth} m
Calculated area | {area} square metres
North | {north}
South | {south}
East | {east}
West | {west}
{note} No legal rights arise from this sample.""",
        """LANDHOLDING REGISTER EXTRACT
Entry {reference}, recorded {date}, maintained by {office}.
Holder field: {person}. Parcel identity: {parcel}. Register locality: {block},
{place}. Land-use field: {land_use}.
Recorded dimensions are {width} metres across and {depth} metres deep;
their product is {area} square metres. The boundary entries are north {north},
south {south}, east {east}, and west {west}.
{note} This extract is not evidence of real ownership.""",
        """Dear {person},
The sample records desk {office} has prepared parcel summary {reference} on
{date}. It concerns {parcel}, in {block}, {place}, listed for {land_use}.
The fictional rectangular plot measures {width} by {depth} metres, with area
{area} square metres. Its north boundary is {north}; south is {south}; east
is {east}; west is {west}. You appear as its fictional recorded holder.
{note} The letter neither transfers nor certifies title.""",
        """LAND RECORD CARD
Parcel {parcel}; recorded holder {person}
Locality {block}, {place}; use {land_use}
Dimensions {width} m x {depth} m; area {area} sq m
N: {north}; S: {south}; E: {east}; W: {west}
Desk {office}; date {date}; record {reference}
{note} No legal ownership or title is established.""",
        """Appendix: parcel area and boundary schedule
Record {reference}, issued {date} by {office}.
The parcel identifier is {parcel}; holder entry {person}; locality {block},
{place}. A width of {width} metres multiplied by a depth of {depth} metres
gives {area} square metres for the fictional rectangular sketch.
Land use: {land_use}. Boundary schedule: north {north}; south {south}; east
{east}; west {west}. {note}
This generated schedule carries no official survey or title status.""",
        """PARCEL RECORD SUMMARY
{office} maintains a fictional entry for {person} concerning {parcel} in
{block}, {place}. The entry, {reference}, was prepared on {date}.
The recorded use is {land_use}; the dimensions are {width} by {depth} metres,
giving {area} square metres. Neighbouring features are {north} to the north,
{south} to the south, {east} to the east, and {west} to the west.
{note} This summary makes no real-world title determination.""",
        """NOTICE OF PARCEL REGISTER DETAILS
Holder entry {person}; notice reference {reference}; date {date}.
{office} lists parcel {parcel} at {block}, {place}, with land use {land_use}.
Illustrative dimensions: {width} metres x {depth} metres; area {area} square metres.
Registered sample boundaries: north {north}, south {south}, east {east}, west {west}.
{note} This notice is an invented record and grants no property rights.""",
        """The fictional land record dated {date} and identified as {reference} lists
{person} as holder of parcel {parcel} in {block}, {place}. It was prepared by
{office}. The recorded use is {land_use}. The sample rectangular dimensions
are {width} metres by {depth} metres, yielding {area} square metres.
The plot is described as bounded by {north} on the north, {south} on the south,
{east} on the east, and {west} on the west. {note}
The narrative is not a deed, a title guarantee, or a legal survey.""",
    ),
    "bank_statement": (
        """ACCOUNT STATEMENT
{bank}; account holder {person}; account {account}.
Statement {reference}, issued {date}; period {start} to {end}.
Opening balance {opening}.
{transactions}
Total credits {deposits}; total debits {withdrawals}; closing balance {closing}.
Reconciliation: opening balance plus credits minus debits equals closing balance.
This statement describes account activity, not a request for payment.""",
        """ACCOUNT ACTIVITY MEMORANDUM
To {person}; from {bank}; account {account}; statement {reference}.
Issued {date} for the period {start} to {end}. The account began with {opening}.
The following entries affected its running balance:
{transactions}
Credits total {deposits} and debits total {withdrawals}. The reconciled closing
balance is {closing}. This memo summarizes the period's account transactions.""",
        """BANK TRANSACTION SCHEDULE
Institution {bank}; customer {person}; account {account}
Reference {reference}; period {start} - {end}; issued {date}
Balance brought forward: {opening}
{transactions}
Period credits | {deposits}
Period debits | {withdrawals}
Balance carried forward | {closing}
The sequence records movements in the account, not separate unpaid charges.""",
        """DEPOSIT ACCOUNT LEDGER EXTRACT
Account {account}, holder {person}, institution {bank}.
Extract {reference}, dated {date}, covers {start} through {end}.
The opening balance of {opening} was adjusted by these posted entries:
{transactions}
Summed deposits: {deposits}. Summed withdrawals: {withdrawals}.
The final ledger balance is {closing}, after applying all six transactions.""",
        """Dear {person},
Your account {account} at {bank} had an opening balance of {opening} for the
statement period {start} to {end}. Its transaction history is shown below.
{transactions}
Total money credited was {deposits}; total money debited was {withdrawals}.
The resulting closing balance is {closing}.
Statement reference {reference}, prepared {date}. This letter summarizes
account activity and does not issue a bill.""",
        """BANK ACCOUNT SUMMARY
{bank}; {person}; account {account}
Period {start} - {end}; date {date}; statement {reference}
Opening {opening}
{transactions}
Credits {deposits}; debits {withdrawals}; closing {closing}
All balances refer to this single fictional account and statement period.""",
        """Annex: account balance reconciliation
Holder {person}; bank {bank}; account {account}.
Statement {reference}, dated {date}, for {start} to {end}.
Opening ledger balance: {opening}.
{transactions}
Total credits added: {deposits}. Total debits deducted: {withdrawals}.
The opening amount plus credits less debits reconciles to {closing}.
The last running-balance entry equals the statement closing balance.""",
        """PERIOD ACCOUNT REVIEW
{bank} records the following activity for {person}, account {account}, between
{start} and {end}. Statement reference {reference}; publication date {date}.
Opening funds: {opening}.
{transactions}
Across these entries, credits add {deposits} and debits remove {withdrawals}.
Closing funds are {closing}. These are transaction-history entries, not
individual demands for settlement.""",
        """ACCOUNT STATEMENT AVAILABILITY NOTICE
Customer {person}; institution {bank}; account {account}.
Statement {reference}, issued {date}, covers {start} to {end}.
The opening balance was {opening}. Posted entries are reproduced here:
{transactions}
Total credits {deposits}; total debits {withdrawals}.
Closing balance {closing}. The notice includes the account's period activity
and does not contain a payment due date.""",
        """For the period {start} to {end}, {bank} prepared account statement
{reference} for {person}, whose fictional account is {account}. It was issued
on {date}. The account opened the period with {opening}, then recorded:
{transactions}
Deposits totalled {deposits} and withdrawals totalled {withdrawals}, leaving
{closing} at the period end. Each running balance includes all preceding
entries in this statement.""",
    ),
    "prescription": (
        """PRESCRIPTION RECORD
{clinic}; clinician {clinician}; patient {person}.
Encounter: {encounter}; date {date}; prescription reference {reference}.
Medication order entries:
{medicines}
Number of listed entries: {count}. Clinical findings and treatment details are
deliberately absent. The fictional entries cannot be dispensed or used as advice.
No clinician signature, registration number, or authorization is represented.""",
        """MEDICATION ORDER MEMORANDUM
Patient {person}; clinician {clinician}; clinic {clinic}.
Recorded {date} following a fictional {encounter}; document {reference}.
The sample prescription contains these {count} medication-order placeholders:
{medicines}
They illustrate document structure only. Clinical findings are omitted and no
usable dosing instructions or dispensing authorization are supplied.""",
        """PRESCRIPTION ENTRY SCHEDULE
Patient | {person}
Clinic | {clinic}
Clinician | {clinician}
Encounter | {encounter}
Recorded date | {date}
Prescription reference | {reference}
Medication order placeholders:
{medicines}
Entry count | {count}
Clinical instructions are intentionally absent; no real medication is ordered.""",
        """PRESCRIBING RECORD EXTRACT
Record {reference}, dated {date}, associates {person} with {clinician} at
{clinic} for a fictional {encounter}.
The medication-order section has {count} entries:
{medicines}
The extract omits clinical findings, actual medicine names, and dosing details.
It contains no valid signature or authority to dispense treatment.""",
        """Patient record for {person}
{clinician}, {clinic}, documented a fictional {encounter} on {date}.
The prescription reference is {reference}. Its medication-order section reads:
{medicines}
There are {count} placeholder entries. Clinical assessment and all actionable
treatment directions are withheld from this training sample. It is not an
authorization for a pharmacy or a source of medical advice.""",
        """PRESCRIPTION SUMMARY CARD
Patient {person}; date {date}; reference {reference}
Clinic {clinic}; clinician {clinician}; encounter {encounter}
Medication entries ({count}):
{medicines}
No diagnosis, dosing guidance, clinical signature, or dispensing authority is
provided. The placeholders are fictional and cannot guide treatment.""",
        """Annex: medication-order section
Prescription record {reference}; entered {date}.
Patient {person}; encounter {encounter}; clinician {clinician}; clinic {clinic}.
The prescription section contains {count} invented entries:
{medicines}
All medication identity and treatment instructions are placeholders or omitted.
The annex demonstrates a document section without authorizing clinical action.""",
        """ENCOUNTER PRESCRIPTION SUMMARY
For the fictional {encounter} on {date}, {clinician} at {clinic} recorded a
prescription section for {person}, reference {reference}.
Its {count} placeholder medicine entries are:
{medicines}
Clinical findings and actionable directions are excluded. This is a generated
document-type example, not a medication list validated for any real patient.""",
        """NOTICE OF PRESCRIPTION RECORD
Patient {person}; sample clinic {clinic}; clinician {clinician}.
Record {reference} relates to a fictional {encounter} dated {date}.
Medication orders are represented by {count} placeholders:
{medicines}
The sample intentionally provides no actual drug identity, dose, clinical
assessment, or dispensing instruction. No real prescription is issued.""",
        """On {date}, {clinician} at {clinic} recorded a fictional prescription
section for {person} after a sample {encounter}. The section is identified as
{reference}. Its {count} medication-order entries are:
{medicines}
The medicine identifiers are invented, and the clinical assessment and all
dosing instructions are omitted. This narrative describes prescription-shaped
training text and cannot support a treatment or dispensing decision.""",
    ),
}


CONTEXT_BUILDERS = {
    "marksheet": _marksheet,
    "educational_certificate": _certificate,
    "utility_bill": _utility,
    "invoice": _invoice,
    "receipt": _receipt,
    "land_record": _land,
    "bank_statement": _bank,
    "prescription": _prescription,
}


def generate_documents(seed: int = 42, per_template: int = 20) -> Iterator[dict]:
    """Yield 8 * 10 * per_template fictional document scenarios, reproducibly.

    Changing per_template preserves earlier scenario IDs and contents. An opaque
    ID is derived from the seed, label, family, and scenario index; it is never a
    model input. Global groups capture shared style across classes and must not
    be broken when generating file formats, image corruptions, or OCR variants.
    """
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise TypeError("seed must be an integer")
    if not isinstance(per_template, int) or isinstance(per_template, bool):
        raise TypeError("per_template must be an integer")
    if per_template < 1:
        raise ValueError("per_template must be a positive integer")
    for label, category in CATEGORIES.items():
        for family, template in enumerate(TEMPLATES[label]):
            for index in range(per_template):
                identity = f"filewise-synthetic-v1:{seed}:{label}:{family}:{index}"
                digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
                rng = random.Random(int(digest, 16))
                context = _base(rng)
                CONTEXT_BUILDERS[label](rng, context)
                text = f"{DISCLAIMER}\n\n{template.format_map(context)}\n"
                if label == "invoice":
                    text += (
                        "Tax is rounded to the nearest paise; half-paise values round upward.\n"
                    )
                yield {
                    "document_id": digest[:24],
                    "label": label,
                    "category": category,
                    "template_id": f"{label}_f{family:02d}",
                    "group_id": f"synthetic_layout_f{family:02d}",
                    "text": text,
                    "language": "en",
                    "is_synthetic": True,
                    "review_status": "synthetic_rule_labeled",
                    "source_id": "filewise_synthetic_v1",
                }
