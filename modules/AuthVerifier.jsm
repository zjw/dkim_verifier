/*
 * AuthVerifier.jsm
 * 
 * Authentication Verifier.
 *
 * Version: 1.0.1 (10 December 2014)
 * 
 * Copyright (c) 2014 Philippe Lieser
 * 
 * This software is licensed under the terms of the MIT License.
 * 
 * The above copyright and license notice shall be
 * included in all copies or substantial portions of the Software.
 */

// options for JSHint
/* jshint strict:true, moz:true, smarttabs:true, unused:true */
/* global Components, Services, Task */
/* global Logging, ARHParser */
/* global dkimStrings, exceptionToStr, getDomainFromAddr, tryGetFormattedString, DKIM_InternalError */
/* exported EXPORTED_SYMBOLS, AuthVerifier */

"use strict";

const module_version = "1.0.1";

var EXPORTED_SYMBOLS = [
	"AuthVerifier"
];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");

Cu.import("resource://dkim_verifier/logging.jsm");
Cu.import("resource://dkim_verifier/helper.jsm");
Cu.import("resource://dkim_verifier/MsgReader.jsm");
Cu.import("resource://dkim_verifier/ARHParser.jsm");
let DKIM = {};
Cu.import("resource://dkim_verifier/dkimPolicy.jsm", DKIM);
Cu.import("resource://dkim_verifier/dkimVerifier.jsm", DKIM);

const PREF_BRANCH = "extensions.dkim_verifier.";

let log = Logging.getLogger("AuthVerifier");
let prefs = Services.prefs.getBranch(PREF_BRANCH);


var AuthVerifier = {
	get version() { return module_version; },

	/**
	 * @typedef {Object} AuthResult
	 * @property {String} version
	 *           result version ("2.0")
	 * @property {AuthResultDKIM[]} dkim
	 * @property {ARHResinfo[]} [spf]
	 * @property {ARHResinfo[]} [dmarc]
	 */

	/**
	 * @typedef {Object} AuthResultDKIM
	 * @extends dkimSigResultV2
	 * @property {Number} res_num
	 *           10: SUCCESS
	 *           20: TEMPFAIL
	 *           30: PERMFAIL
	 *           35: PERMFAIL treat as no sig
	 *           40: no sig
	 * @property {String} result_str
	 *           localized result string
	 * @property {String[]} [warnings_str]
	 *           localized warnings
	 */

	/**
	 * Verifies the authentication of the msg.
	 *
	 * @param {nsIMsgDBHdr} msgHdr
	 * @param {String} [msgURI=""] Required if msg is external.
	 * @return {Promise<AuthResult>}
	 */
	verify: function _authVerifier_verify(msgHdr, msgURI) {
		var promise = Task.spawn(function () {
			// check for saved AuthResult
			let authResult = loadAuthResult(msgHdr);
			if (authResult) {
				throw new Task.Result(authResult);
			}

			// get msgURI if not specified
			if (!msgURI) {
				msgURI = msgHdr.folder.getUriForMsg(msgHdr);
			}

			// create msg object
			let msg = yield DKIM.Verifier.createMsg(msgURI);

			// read Authentication-Results header
			authResult = getARHResult(msg);

			if (!authResult) {
				// verify DKIM signatures
				let dkimResultV2 = yield DKIM.Verifier.verify2(msg);
				authResult = {
					version: "2.0",
					dkim: dkimResultV2.signatures.map(dkimSigResultV2_to_AuthResultDKIM),
				};
			}

			// save AuthResult
			saveAuthResult(msgHdr, authResult);

			throw new Task.Result(authResult);
		});
		promise.then(null, function onReject(exception) {
			log.warn(exceptionToStr(exception));
		});
		return promise;
	},

	/**
	 * Resets the stored authentication result of the msg.
	 *
	 * @param {nsIMsgDBHdr} msgHdr
	 * @return {Promise<Undefined>}
	 */
	resetResult: function _authVerifier_resetResult(msgHdr) {
		var promise = Task.spawn(function () {
			saveAuthResult(msgHdr, "");
		});
		promise.then(null, function onReject(exception) {
			log.warn(exceptionToStr(exception));
		});
		return promise;
	},
};

/**
 * Get the Authentication-Results header as an AuthResult.
 * 
 * @param {Object} msg
 * @return {AuthResult|Null}
 */
function getARHResult(msg) {
	if (!prefs.getBoolPref("arh.read") ||
	    !msg.headerFields.has("authentication-results")) {
		return null;
	}

	// get DKIM, SPF and DMARC res
	let arhDKIM = [];
	let arhSPF = [];
	let arhDMARC = [];
	for (let i = 0; i < msg.headerFields.get("authentication-results").length; i++) {
		let arh;
		try {
			arh = ARHParser.parse(msg.headerFields.get("authentication-results")[i]);
		} catch (exception) {
			log.error(exceptionToStr(exception));
			continue;
		}
		arhDKIM = arhDKIM.concat(arh.resinfo.filter(function (element) {
			return element.method === "dkim";
		}));
		arhSPF = arhSPF.concat(arh.resinfo.filter(function (element) {
			return element.method === "spf";
		}));
		arhDMARC = arhDMARC.concat(arh.resinfo.filter(function (element) {
			return element.method === "dmarc";
		}));
	}

	// convert DKIM results
	let dkimSigResults = arhDKIM.map(arhDKIM_to_dkimSigResultV2);

	// check for signature existents
	DKIM.Verifier.checkForSignatureExsistens(msg, dkimSigResults);

	// check SDID and AUID of DKIM results
	for (let i = 0; i < dkimSigResults.length; i++) {
		if (dkimSigResults[i].result === "SUCCESS") {
			try {
				DKIM.Policy.checkSDID(
					msg.DKIMSignPolicy.sdid,
					msg.from,
					dkimSigResults[i].sdid,
					dkimSigResults[i].auid,
					dkimSigResults[i].warnings
				);
			} catch(exception) {
				dkimSigResults[i] = DKIM.Verifier.handleExeption(
					exception,
					msg,
					{d: dkimSigResults[i].sdid, i: dkimSigResults[i].auid}
				);
			}
		}
	}

	// sort signatures
	DKIM.Verifier.sortSignatures(msg, dkimSigResults);

	let authResult = {
		version: "2.0",
		dkim: dkimSigResults.map(dkimSigResultV2_to_AuthResultDKIM),
		spf: arhSPF,
		dmarc: arhDMARC,
	};
	return authResult;
}

/**
 * Save authentication result
 * 
 * @param {nsIMsgDBHdr} msgHdr
 * @param {AuthResult} authResult
 */
function saveAuthResult(msgHdr, authResult) {
	if (prefs.getBoolPref("saveResult")) {
		// don't save result if message is external
		if (!msgHdr.folder) {
			log.debug("result not saved because message is external");
			return;
		}

		if (authResult === "") {
			// reset result
			log.debug("reset AuthResult result");
			msgHdr.setStringProperty("dkim_verifier@pl-result", "");
		} else if (authResult.dkim[0].result === "TEMPFAIL") {
			// don't save result if DKIM result is a TEMPFAIL
			log.debug("result not saved because DKIM result is a TEMPFAIL");
		} else {
			log.debug("save AuthResult result");
			msgHdr.setStringProperty("dkim_verifier@pl-result", JSON.stringify(authResult));
		}
	}
}

/**
 * Get saved authentication result
 * 
 * @param {nsIMsgDBHdr} msgHdr
 * @return {AuthResult|Null} authResult
 */
function loadAuthResult(msgHdr) {
	if (prefs.getBoolPref("saveResult")) {
		// don't read result if message is external
		if (!msgHdr.folder) {
			return null;
		}

		let authResult = msgHdr.getStringProperty("dkim_verifier@pl-result");

		if (authResult !== "") {
			log.debug("AuthResult result found: "+authResult);

			authResult = JSON.parse(authResult);

			if (authResult.version.match(/^[0-9]+/)[0] === "1") {
				// old dkimResultV1 (AuthResult version 1)
				let res = {
					version: "2.0",
					dkim: [dkimSigResultV2_to_AuthResultDKIM(
						dkimResultV1_to_dkimSigResultV2(authResult))],
				};
				return res;
			}
			if (authResult.version.match(/^[0-9]+/)[0] === "2") {
				// AuthResult version 2
				return authResult;
			}

			throw new DKIM_InternalError("AuthResult result has wrong Version (" +
				authResult.version + ")");
		}
	}

	return null;
}

/**
 * Convert DKIM ARHresinfo to dkimResult
 * 
 * @param {ARHresinfo} arhDKIM
 * @return {dkimSigResultV2}
 */
function arhDKIM_to_dkimSigResultV2(arhDKIM) {
	let dkimSigResult = {};
	dkimSigResult.version = "2.0";
	switch (arhDKIM.result) {
		case "none":
			dkimSigResult.result = "none";
			break;
		case "pass":
			dkimSigResult.result = "SUCCESS";
			dkimSigResult.warnings = [];
			let sdid = arhDKIM.propertys.header.d;
			let auid = arhDKIM.propertys.header.i;
			if (sdid || auid) {
				if (!sdid) {
					sdid = getDomainFromAddr(auid);
				} else if (!auid) {
					auid = "@" + sdid;
				}
				dkimSigResult.sdid = sdid;
				dkimSigResult.auid = auid;
			}
			break;
		case "fail":
		case "policy":
		case "neutral":
		case "permerror":
			dkimSigResult.result = "PERMFAIL";
			if (arhDKIM.reason) {
				dkimSigResult.errorType = arhDKIM.reason;
			} else {
				dkimSigResult.errorType = "";
			}
			break;
		case "temperror":
			dkimSigResult.result = "TEMPFAIL";
			if (arhDKIM.reason) {
				dkimSigResult.errorType = arhDKIM.reason;
			} else {
				dkimSigResult.errorType = "";
			}
			break;
		default:
			throw new DKIM_InternalError("invalid dkim result in arh: " +
				arhDKIM.result);
	}
	return dkimSigResult;
}

/**
 * Convert dkimResultV1 to dkimSigResultV2
 * 
 * @param {dkimResultV1} dkimResult
 * @return {dkimSigResultV2}
 */
function dkimResultV1_to_dkimSigResultV2(dkimResultV1) {
	let dkimSigResultV2 = {
		version: "2.0",
		result: dkimResultV1.result,
		sdid: dkimResultV1.SDID,
		selector: dkimResultV1.selector,
		errorType: dkimResultV1.errorType,
		hideFail: dkimResultV1.hideFail,
	};
	if (dkimResultV1.warnings) {
		dkimSigResultV2.warnings = dkimResultV1.warnings.map(
			function (w) {
				if (w === "DKIM_POLICYERROR_WRONG_SDID") {
					return {name: w, params: [dkimResultV1.shouldBeSignedBy]};
				}
				return {name: w};
			}
		);
	}
	if (dkimResultV1.errorType === "DKIM_POLICYERROR_WRONG_SDID" ||
	    dkimResultV1.errorType === "DKIM_POLICYERROR_MISSING_SIG") {
		dkimSigResultV2.errorStrParams = [dkimResultV1.shouldBeSignedBy];
	}
	return dkimSigResultV2;
}

/**
 * Convert dkimSigResultV2 to AuthResultDKIM
 * 
 * @param {dkimSigResultV2} dkimSigResult
 * @return {AuthResultDKIM}
 * @throws DKIM_InternalError
 */
function dkimSigResultV2_to_AuthResultDKIM(dkimSigResult) {
	let authResultDKIM = dkimSigResult;
	switch(dkimSigResult.result) {
		case "SUCCESS":
			authResultDKIM.res_num = 10;
			authResultDKIM.result_str = dkimStrings.getFormattedString("SUCCESS",
				[dkimSigResult.sdid]);
			authResultDKIM.warnings_str = dkimSigResult.warnings.map(function(e) {
				return tryGetFormattedString(dkimStrings, e.name, e.params) || e.name;
			});
			break;
		case "TEMPFAIL":
			authResultDKIM.res_num = 20;
			authResultDKIM.result_str =
				tryGetFormattedString(dkimStrings, dkimSigResult.errorType,
					dkimSigResult.errorStrParams) ||
				dkimSigResult.errorType ||
				dkimStrings.getString("DKIM_INTERNALERROR_NAME");
			break;
		case "PERMFAIL":
			if (dkimSigResult.hideFail) {
				authResultDKIM.res_num = 35;
			} else {
				authResultDKIM.res_num = 30;
			}
			let errorMsg =
				tryGetFormattedString(dkimStrings, dkimSigResult.errorType,
					dkimSigResult.errorStrParams) ||
				dkimSigResult.errorType;
			if (errorMsg) {
				authResultDKIM.result_str = dkimStrings.getFormattedString("PERMFAIL",
					[errorMsg]);
			} else {
				authResultDKIM.result_str = dkimStrings.getString("PERMFAIL_NO_REASON");
			}
			break;
		case "none":
			authResultDKIM.res_num = 40;
			authResultDKIM.result_str = dkimStrings.getString("NOSIG");
			break;
		default:
			throw new DKIM_InternalError("unkown result: " + dkimSigResult.result);
	}

	return authResultDKIM;
}
