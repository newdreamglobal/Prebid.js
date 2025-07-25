import {
  deepAccess,
  getBidRequest,
  getParameterByName,
  isArray,
  isNumber,
  isPlainObject,
  logError
} from '../src/utils.js';
import {config} from '../src/config.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER} from '../src/mediaTypes.js';
import {getStorageManager} from '../src/storageManager.js';
import {hasPurpose1Consent} from '../src/utils/gdpr.js';
import {getANKeywordParam} from '../libraries/appnexusUtils/anKeywords.js';
import {convertCamelToUnderscore} from '../libraries/appnexusUtils/anUtils.js';
import { transformSizes } from '../libraries/sizeUtils/tranformSize.js';
import {addUserId, hasUserInfo, hasAppDeviceInfo, hasAppId, getBidFloor} from '../libraries/adrelevantisUtils/bidderUtils.js';

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 */

const BIDDER_CODE = 'winr';
const URL = 'https://ib.adnxs.com/ut/v3/prebid';
const URL_SIMPLE = 'https://ib.adnxs-simple.com/ut/v3/prebid';
const USER_PARAMS = ['age', 'externalUid', 'segments', 'gender', 'dnt', 'language'];
const APP_DEVICE_PARAMS = ['geo', 'device_id']; // appid is collected separately
const SOURCE = 'pbjs';
const DEFAULT_CURRENCY = 'USD';
const GATE_COOKIE_NAME = 'wnr_gate';

export const storage = getStorageManager({bidderCode: BIDDER_CODE});

function buildBid(bidData) {
  const bid = bidData;
  const position = {
    domParent: bid.meta.domParent ? `'${bid.meta.domParent}'` : null,
    child: bid.meta.child ? bid.meta.child : 4
  }
  bid.ad = wrapAd(bid, position);
  return bid;
}

function getMediaTypeFromBid(bid) {
  return bid.mediaTypes && Object.keys(bid.mediaTypes)[0];
}

function wrapAd(bid, position) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title></title>
        <style>html, body {width: 100%; height: 100%; margin: 0;}</style>
    </head>
    <body>
      <script>
        function winrPbRendererLoad(cb) {
          var w = parent.document.createElement("script");
          w.innerHTML = \`
            var WINR = {
              pubDocRef: parent.document,
              pubWinRef: window.parent
            };
            var winrLib = null;
            var winrParams = {
              rtb: {
                _eng: 'xan',
                _plmnt: ${bid.meta.placementId}
              },
              inR: {
                tg: ${position.domParent},
                rf: ${position.child}
              }};
          \`;
          var s = parent.document.head.getElementsByTagName("script")[0];
          s.parentNode.insertBefore(w, s);
          var n = parent.document.createElement("script");
          n.src = 'https://helpers.winr.com.au/dist/prebidRenderer.js';
          n.onload = function () {
            var WinrLib = window.parent.WinrPbRenderer.default;
            window.parent.winrLib = new WinrLib();
            if (!window.parent.winrLib) {
              console.log("Wnr: Renderer not found");
              return false;
            } else {
              cb();
            }
          };
          var t = parent.document.head.getElementsByTagName("script")[0];
          t.parentNode.insertBefore(n, t.nexSibling);
        }
        winrPbRendererLoad(function() {
          var tag = "${encodeURIComponent(JSON.stringify(bid))}";
          window.parent.winrLib.render(tag);
        });
      </script>
    </body>
  </html>`;
}

export const spec = {
  code: BIDDER_CODE,
  aliases: ['wnr'],
  supportedMediaTypes: [BANNER],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bid) {
    // Return false for each bid request if the media type is not 'banner'
    if (getMediaTypeFromBid(bid) !== BANNER) {
      return false;
    }

    // Return false for each bid request if the cookies disabled
    if (!storage.cookiesAreEnabled()) {
      return false;
    }

    // Return false for each bid request if the gate cookie is set
    if (storage.getCookie(GATE_COOKIE_NAME) !== null) {
      return false;
    }

    // Return false for each bid request if no placementId exists
    if (!bid.params.placementId) {
      return false;
    }

    return true;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function (bidRequests, bidderRequest) {
    const tags = bidRequests.map(bidToTag);
    const userObjBid = ((bidRequests) || []).find(hasUserInfo);
    let userObj = {};
    if (config.getConfig('coppa') === true) {
      userObj = { 'coppa': true };
    }

    if (userObjBid) {
      Object.keys(userObjBid.params.user)
        .filter((param) => USER_PARAMS.includes(param))
        .forEach((param) => {
          const uparam = convertCamelToUnderscore(param);
          if (
            param === 'segments' &&
            isArray(userObjBid.params.user[param])
          ) {
            const segs = [];
            userObjBid.params.user[param].forEach((val) => {
              if (isNumber(val)) {
                segs.push({ id: val });
              } else if (isPlainObject(val)) {
                segs.push(val);
              }
            });
            userObj[uparam] = segs;
          } else if (param !== 'segments') {
            userObj[uparam] = userObjBid.params.user[param];
          }
        });
    }

    const appDeviceObjBid = ((bidRequests) || []).find(hasAppDeviceInfo);
    let appDeviceObj;
    if (appDeviceObjBid && appDeviceObjBid.params && appDeviceObjBid.params.app) {
      appDeviceObj = {};
      Object.keys(appDeviceObjBid.params.app)
        .filter(param => APP_DEVICE_PARAMS.includes(param))
        .forEach(param => {
          appDeviceObj[param] = appDeviceObjBid.params.app[param];
        });
    }

    const appIdObjBid = ((bidRequests) || []).find(hasAppId);
    let appIdObj;
    if (appIdObjBid && appIdObjBid.params && appDeviceObjBid.params.app && appDeviceObjBid.params.app.id) {
      appIdObj = {
        appid: appIdObjBid.params.app.id
      };
    }

    const memberIdBid = ((bidRequests) || []).find(hasMemberId);
    const member = memberIdBid ? parseInt(memberIdBid.params.member, 10) : 0;
    const schain = bidRequests[0]?.ortb2?.source?.ext?.schain;

    const payload = {
      tags: [...tags],
      user: userObj,
      sdk: {
        source: SOURCE,
        version: '$prebid.version$',
      },
      schain: schain
    };

    if (member > 0) {
      payload.member_id = member;
    }

    if (appDeviceObjBid) {
      payload.device = appDeviceObj;
    }
    if (appIdObjBid) {
      payload.app = appIdObj;
    }

    if (bidderRequest && bidderRequest.gdprConsent) {
      // note - objects for impbus use underscore instead of camelCase
      payload.gdpr_consent = {
        consent_string: bidderRequest.gdprConsent.consentString,
        consent_required: bidderRequest.gdprConsent.gdprApplies,
      };
    }

    if (bidderRequest && bidderRequest.uspConsent) {
      payload.us_privacy = bidderRequest.uspConsent;
    }

    if (bidderRequest && bidderRequest.refererInfo) {
      const refererinfo = {
        // TODO: this collects everything it finds, except for canonicalUrl
        rd_ref: encodeURIComponent(bidderRequest.refererInfo.topmostLocation),
        rd_top: bidderRequest.refererInfo.reachedTop,
        rd_ifs: bidderRequest.refererInfo.numIframes,
        rd_stk: bidderRequest.refererInfo.stack
          .map((url) => encodeURIComponent(url))
          .join(','),
      };
      payload.referrer_detection = refererinfo;
    }

    if (bidRequests[0].userId) {
      const eids = [];

      addUserId(eids, deepAccess(bidRequests[0], `userId.criteoId`), 'criteo.com', null);
      addUserId(eids, deepAccess(bidRequests[0], `userId.netId`), 'netid.de', null);
      addUserId(eids, deepAccess(bidRequests[0], `userId.idl_env`), 'liveramp.com', null);
      addUserId(eids, deepAccess(bidRequests[0], `userId.tdid`), 'adserver.org', 'TDID');
      addUserId(eids, deepAccess(bidRequests[0], `userId.uid2.id`), 'uidapi.com', 'UID2');

      if (eids.length) {
        payload.eids = eids;
      }
    }

    if (tags[0].publisher_id) {
      payload.publisher_id = tags[0].publisher_id;
    }

    const request = formatRequest(payload, bidderRequest);
    return request;
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, { bidderRequest }) {
    serverResponse = serverResponse.body;
    const bids = [];
    if (!serverResponse || serverResponse.error) {
      let errorMessage = `in response for ${bidderRequest.bidderCode} adapter`;
      if (serverResponse && serverResponse.error) {
        errorMessage += `: ${serverResponse.error}`;
      }
      logError(errorMessage);
      return bids;
    }

    if (serverResponse.tags) {
      serverResponse.tags.forEach((serverBid) => {
        const rtbBid = getRtbBid(serverBid);
        if (rtbBid) {
          if (
            rtbBid.cpm !== 0 &&
            this.supportedMediaTypes.includes(rtbBid.ad_type)
          ) {
            const bid = newBid(serverBid, rtbBid, bidderRequest);
            bid.mediaType = parseMediaType(rtbBid);
            bids.push(bid);
          }
        }
      });
    }

    return bids.map(bid => buildBid(bid));
  },

  getUserSyncs: function (syncOptions) {
    if (syncOptions.iframeEnabled) {
      return [
        {
          type: 'iframe',
          url: 'https://acdn.adnxs.com/dmp/async_usersync.html',
        },
      ];
    }
  },
};

function formatRequest(payload, bidderRequest) {
  let request = [];
  const options = {
    withCredentials: true
  };

  let endpointUrl = URL;

  if (!hasPurpose1Consent(bidderRequest?.gdprConsent)) {
    endpointUrl = URL_SIMPLE;
  }

  if (
    getParameterByName('apn_test').toUpperCase() === 'TRUE' ||
    config.getConfig('apn_test') === true
  ) {
    options.customHeaders = {
      'X-Is-Test': 1,
    };
  }

  const payloadString = JSON.stringify(payload);
  request = {
    method: 'POST',
    url: endpointUrl,
    data: payloadString,
    bidderRequest,
    options,
  };

  return request;
}

/**
 * Unpack the Server's Bid into a Prebid-compatible one.
 * @param serverBid
 * @param rtbBid
 * @param bidderRequest
 * @return Bid
 */
function newBid(serverBid, rtbBid, bidderRequest) {
  const bidRequest = getBidRequest(serverBid.uuid, [bidderRequest]);
  const bid = {
    adType: rtbBid.ad_type,
    requestId: serverBid.uuid,
    // TODO: fix auctionId leak: https://github.com/prebid/Prebid.js/issues/9781
    auctionId: bidRequest.auctionId,
    cpm: rtbBid.cpm,
    creativeId: rtbBid.creative_id,
    brandCategoryId: rtbBid.brandCategoryId,
    dealId: rtbBid.deal_id,
    currency: DEFAULT_CURRENCY,
    netRevenue: true,
    ttl: 300,
    source: rtbBid.content_source,
    mediaSubtypeId: rtbBid.media_subtype_id,
    mediaTypeId: rtbBid.media_type_id,
    adUnitCode: bidRequest.adUnitCode,
    buyerMemberId: rtbBid.buyer_member_id,
    appnexus: {
      buyerMemberId: rtbBid.buyer_member_id,
      dealPriority: rtbBid.deal_priority,
      dealCode: rtbBid.deal_code,
    }
  };

  // WE DON'T FULLY SUPPORT THIS ATM - future spot for adomain code; creating a stub for 5.0 compliance
  if (rtbBid.adomain) {
    bid.meta = Object.assign({}, bid.meta, { advertiserDomains: [] });
  }

  if (rtbBid.advertiser_id) {
    bid.meta = Object.assign({}, bid.meta, {
      advertiserId: rtbBid.advertiser_id,
    });
  }

  if (bidRequest.params) {
    const { placementId, siteId, domParent, child } = bidRequest.params;
    bid.meta = Object.assign({}, bid.meta, {
      placementId: placementId,
      siteId: siteId,
      domParent: domParent,
      child: child
    });
  }

  Object.assign(bid, {
    width: rtbBid.rtb.banner.width,
    height: rtbBid.rtb.banner.height,
  });

  try {
    if (rtbBid.rtb.banner && rtbBid.rtb.trackers) {
      bid.banner = Object.assign({}, bid.banner, {
        content: rtbBid.rtb.banner.content,
        width: rtbBid.rtb.banner.width,
        height: rtbBid.rtb.banner.height,
        trackers: rtbBid.rtb.trackers,
      });
    }
  } catch (error) {
    logError('Error assigning ad', error);
  }
  return bid;
}

function bidToTag(bid) {
  const tag = {};
  tag.sizes = transformSizes(bid.sizes);
  tag.primary_size = tag.sizes[0];
  tag.ad_types = [];
  tag.uuid = bid.bidId;
  if (bid.params.placementId) {
    tag.id = parseInt(bid.params.placementId, 10);
  } else {
    tag.code = bid.params.invCode;
  }
  tag.allow_smaller_sizes = bid.params.allowSmallerSizes || false;
  tag.use_pmt_rule = bid.params.usePaymentRule || false;
  tag.prebid = true;
  tag.disable_psa = true;
  const bidFloor = getBidFloor(bid);
  if (bidFloor) {
    tag.reserve = bidFloor;
  }
  if (bid.params.trafficSourceCode) {
    tag.traffic_source_code = bid.params.trafficSourceCode;
  }
  if (bid.params.privateSizes) {
    tag.private_sizes = transformSizes(bid.params.privateSizes);
  }
  if (bid.params.pubClick) {
    tag.pubclick = bid.params.pubClick;
  }
  if (bid.params.publisherId) {
    tag.publisher_id = parseInt(bid.params.publisherId, 10);
  }
  if (bid.params.externalImpId) {
    tag.external_imp_id = bid.params.externalImpId;
  }
  tag.keywords = getANKeywordParam(bid.ortb2, bid.params.keywords)

  const gpid = deepAccess(bid, 'ortb2Imp.ext.gpid');
  if (gpid) {
    tag.gpid = gpid;
  }

  tag.hb_source = 1;

  if (tag.ad_types.length === 0) {
    delete tag.ad_types;
  }

  return tag;
}

function getRtbBid(tag) {
  return tag && tag.ads && tag.ads.length && ((tag.ads) || []).find((ad) => ad.rtb);
}

function parseMediaType(rtbBid) {
  const adType = rtbBid.ad_type;
  if (adType !== BANNER) {
    return false;
  }
  return BANNER;
}

function hasMemberId(bid) {
  return !!parseInt(bid.params.member, 10);
}

registerBidder(spec);
