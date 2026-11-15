---
owner: Classified
status: redacted
depends_on: ["[[Do not circulate - echo 47]]", "[[Build 7 test report]]", "[[Frost chain of custody]]"]
tags: [classified, director, mystery]
---
# What answers us

*I. Calloway, Director, Halcyon Relay Authority. Kept outside every team folder on purpose. Last revised 31 May 2191.*

If you are reading this, someone decided you needed to, and I agree with them. Read it to the end before you tell anyone. Then tell the people who need to know, and nobody else, until the Disclosure Board has it.

## What we told ourselves

The Meridian Net was sold, by me among others, as plumbing. A dish sends, a dish receives, the light takes the time the light takes. Nothing out there is touched. Nothing answers.

Echo 47 says something answers. I have known that for longer than the case has existed.

## What echo 47 actually showed

On 3 March Tern-9 ran live listen LL-03, profiled at power 0.25. The readback went to 0.34 and held there for three seconds. The relay clock logged the reply twice. The send command is at 22:14:07.000. The first receive entry is at 22:14:06.290. Teodor called it jitter. Timekeepers proved on 21 March that our clocks do not jitter by a third of a nanosecond, let alone seven tenths of a second. Imani kept a list of every echo: nothing below power 0.31, something above 0.32, every time.

Every receiver on the dish rang at 2.3 GHz, outside the traffic band, starting *with the first entry*, not the second. The strain gauges on the receiver tiles saw a 1.92 kHz line at the same moment: the ring, beating down through the mount. And the bay microphone heard ticking at 22:14:05.58: 0.71 s before the reply even reached the feed. We had not found the frost yet. The ticking was already there, and it was early by the same amount.

## The fold test

In 2189 the Authority ran a **fold test** near Tern-9. The vessel was HX-2, our test ship, with a fold field generator built under a budget line called "relay extension research". The idea was to shorten the gap a relay signal crosses: a Net with no light-hours in it. I signed the budget. I watched the test from Corvel. Nineteen days of the sector traffic log were closed by my office afterwards, and the approval for that is in my safe, not in any folder.

The fold worked for eleven seconds. It also touched something.

## The working explanation

Here it is, as plainly as I can put it.

Space near Tern-9 is not empty. Beneath it there is a structured medium that the HX-2 physicists and I have been calling, for want of anything better, **the substrate**. The fold disturbed it. Since then, the substrate answers. Any transmission above about power 0.32 couples into it the way the fold did, and the substrate sends back a reply.

The reply is not bound to our clocks. It arrives, as measured on our side, about 0.71 seconds before the transmission that causes it. I do not understand how an answer can lead its question. Neither did anyone on HX-2. The numbers do not care.

What matters for the Net is mechanical. The reply rings receivers in the band near 2.3 GHz. The timestamp-fault model covers the clock register and the sample counter, because that is where every fault we knew about lives; it never included the front end. The standard relay front end has a gain *peak* right at 2.2 to 2.4 GHz: at that frequency it does not reject, it rings. The ring sets up a standing pattern on the dish face, and the nodes of that pattern are where the frost gathers. The keeper mapped nine of them on 11 April.

The Q-9 quiet receiver, the slow backup the Annex parked in March, has its front end shielded outside the 2.3 GHz ring band. It should stay quiet through the ring. It is not better made than build 7. It is *placed* differently. If we switch, we must switch for that reason, or we will place the next receiver wrong as well.

## Why the power runs away

Echo 47 did not overshoot because the controller misbehaved. The feed held the 0.25 profile the whole time; the readback went to 0.34 on its own. Once a transmission is past about 0.25, the substrate answers it, and part of that answer comes back into our own feed, so the dish reads hotter than we drove it. Below about 0.30 the extra dies away. Past 0.32 the answer is strong enough to come back whole: the 0.71 s lead and the 2.3 GHz ring together, every time. Echoes 1 to 46 were all high-power service passes, all filed as clock noise by stations that had no reason to look twice. I capped every transmission at 0.30 because 0.30 is the highest anyone has sent without hearing back.

Echo 52 is the one I cannot explain. On 2 April the summary logged it at 0.29, under the cap. The raw chain shows a reply, a 40 ms rise above 0.32, and no send. Tern-9 never sent message 52. The frost fed on it anyway. Either the answer is not always to us, or it is to something we have not sent yet.

## The frost

The frost came aboard on dish panel 7, which came off HX-2 after the test (see [[Frost chain of custody]]). It grew on HX-2's receiver face during the fold. I had the panel fitted to Tern-9 in the 2189 refit because I wanted a listener where the substrate had been touched, and I did not want a purchase order that said why. It slept through two warm years until the February cryo upgrade took the dish face below 60 K. It ticks and re-forms about 0.7 s before each echo arrives, because it is not reacting to our receivers. It is reacting to the answer itself. It gains mass only after transmissions above 0.32, including the reply to message 52. I believe it feeds on the energy the answer leaves in the dish, which is why it gathers on the ring nodes.

It does not make the echo. CAP-014b settles that. It hears it before we do.

Signals Lab wants it in the clock loop. Xenobiology wants it incinerated. I want neither until the Disclosure Board has ruled, and I have written that into R12.

## The other loose ends

- **The transcript.** The voice loop to Corvel shares the receiver rack's earth. At 2.3 GHz the ring coupled into that earth, and the loop's protection tripped at 22:14:07.4. Nothing cut Teodor off on purpose.
- **IR-0412.** At 03:40 on 9 April a scheduled beacon went out at 0.33 under the exemption I had given the beacon service. The answer put a short, hard load into the dish face: the jump in the cryo loop and the pressure transient. The alarm logged early because the plant's pressure sensor sits on the same front end. It is how the frost became visible that night: it had just fed.
- **The clock vendor.** Teodor asked them in March whether their oscillators "ever double-log a receive". That is where their joke in B-02 comes from. He did not tell them why; he did not need to.

## The build

Pellam's own test report on build 7 is in this folder ([[Build 7 test report]]). Build 7 passed. There is no timestamp defect. There is nothing wrong with the firmware we bought.

## What I did, and why

On 4 March I capped every transmission at 0.30 and redacted the LL-03 page ([[Do not circulate - echo 47]]). On 20 April I made one exception (D-009): CAP-014 goes to 0.33 after transmission 200, "per the echo model update". There is no echo model update that needs it. I needed to see the echo arrive with no firmware and no ORRIN in the room. I already knew it would. On 5 May I signed waiver W-07 so the empty-dish capture could get there first. I wrote "because I want to see it" on the form, which was the most honest line I put on paper this spring.

## What should happen next

1. Fit Q-9 receivers across the Net, for the band reason above, and say so in the Firmware 7 file.
2. Add the answer to the Disclosure case as its own hazard, with the 0.71 s lead and the 2.3 GHz ring as the evidence.
3. Withdraw Firmware 7. Pellam deserves that, and so does Hesper.
4. Keep the frost out of the clock loop until the ethics question is answered.
5. Tell the keepers. They sleep next to it.

## Who changed the story

On 29 May, the day after B-01 went up, Corin Ashdale asked Pellam to reissue the build 7 release notes with a timestamp defect (the message is in this folder too). He did it because I asked him to. Pellam refused, which is to their credit and not to mine. I chose the cover because a Net that is answered by something under space is a Net nobody will trust with a heartbeat, and the Authority would not be funded long enough to learn what is answering. A bad firmware build is a procurement story. I wanted the Net alive, and trusted, until we understood it. That was wrong, and B-01 is the cost: a blocker that blames a vendor for our fold. When CAP-014 crosses into 0.33 after transmission 200, it will log the echo with nothing in the room to blame, and people will reach for Firmware 7 because it is there. I am asking them not to. I am also asking for a little more time.

*— I. Calloway*

*"Keep it a glitch until we know what it is answering."*
