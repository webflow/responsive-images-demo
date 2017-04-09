/* =========== Imports ================================= */
const fs = require('fs');
const del = require('del');
const step = require('step');
const sizeOf = require('image-size');
const sharp = require('sharp');
const webdriver = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const chromedriver = require('chromedriver');

/* =========== CONSTS ================================= */
const VARIANT_WIDTHS = [500, 800, 1080, 1400, 1800, 2400, 3200];
const MAX_VIEWABLE_QUERY = 10000;
const MEDIA_QUERIES = [480, 768, 992, 1200].concat(MAX_VIEWABLE_QUERY);

/* =========== Bootstrap ================================= */
let driver;
const files = {}; // Maps filenames to file metadata
const imgIdToFileMap = {}; // Maps <img> element ids to filenames
const imgSizesArrays = {}; // Maps <img> element ids to uncompiled image measurements
const sizesAttributes = {}; // Maps <img> element ids to compiled sizes attribute values

const srcFolder = './src/';
const srcImagesFolder = srcFolder + 'images/';

const dstFolder = './gen/';
const dstImagesFolder = dstFolder + 'images/';
const dstVariantsFolder = dstFolder + 'variants/';

const variantFolderRelPath = 'variants/'; // the root path to the variants folder when used in index.html

chrome.setDefaultService(new chrome.ServiceBuilder(chromedriver.path).build());

log('Create /gen folder');

// Re-create the destination folders
del.sync(dstFolder, {force: true});

fs.mkdirSync(dstFolder);
fs.mkdirSync(dstImagesFolder);
fs.mkdirSync(dstVariantsFolder);

/* =========== Main process ================================= */
step(
function() {  generateResponsiveVariants(this);   },
function() {  generateResponsiveAttributes(this); },
function() {  log('Complete.')                    }
);

/* =========== Main Methods ================================= */
/*
  Iterates over the src images folder generating appropriate responsive image variants for each one
  and builds the files object with metadata we'll use during the measurement and compilation steps
 */
function generateResponsiveVariants(next) {
  log('Generate responsive variants');

  const filenames = fs.readdirSync(srcImagesFolder);

  filenames.forEach((filename) => {
    // Only process .jpgs
    if (!(/\.jpg$/).test(filename)) { return; }

    const srcImgPath = srcImagesFolder + filename;
    const dstImgPath = dstImagesFolder + filename;

    // Read the master file data
    const buffer = fs.readFileSync(srcImgPath);

    // Write the master file to the gen/images folder
    fs.writeFileSync(dstImgPath, buffer);

    // Read some metadata from the master image
    const size = buffer.length;
    const {width, height} = sizeOf(srcImgPath)

    // For each variant width that's smaller than the master image, generate a variant
    const variants = VARIANT_WIDTHS.filter((targetWidth) => {
      if (width > targetWidth) {

        sharp(srcImgPath)

          /** TIP **
            In this example we're just resizing the master image using libvips. There's a whole world of lossy and lossless compression
            out there that can be applied to variants after this step to further minimize filesize
          */

          .resize(targetWidth)

          /** TIP **
            Instead of just accepting each variant we generated, due to subtleties in jpeg compression
            it's possible variant (eg: 500w) can have larger filesize than another with larger dimensinos (eg: 800w)
            These can be discarded.
          */

          .toFile(dstVariantsFolder + getVariantName(filename, targetWidth))
          .then(next.parallel());

        return true;
      }
    });

    // Keep track of all the metadata we just gathered
    files[filename] = {
      filename,
      srcImgPath,
      size,
      width,
      height,
      variants
    };
  });
}

/*
  The main body of everything we do in chrome. We're going to render index.html,
  build the imgIdToFileMap mapping <img> elements to files used,
  take measurements of how <img> element renders at each media query,
  then use chrome as an html parser to generate the output html
 */
function generateResponsiveAttributes(next) {
  log('Fire up Chrome and Render index.html');

  driver = new webdriver.Builder()
    .forBrowser('chrome')
    .build();

  // Override the timeout for webdriver, this is like a master timeout for the scripts we
  // run inside the browser
  driver.manage().timeouts().setScriptTimeout(60000);

  driver
    // Load index.html
    .then(() => driver.get('file://' + __dirname + '/src/index.html'))
    .then(() => driver.executeAsyncScript(waitUntilDocumentReady))

    // Scan index.html and create a map of <img> id to file url to help us build the srcset attributes later
    .then(() => driver.executeAsyncScript(mapIdsToFiles))
    .then((idToFileMap) => Object.assign(imgIdToFileMap, idToFileMap))

    // Resize the browser to each media query and collect measurements to help us build the sizes attributes later
    .then(() => measureImagesInBrowser())

    // Compile the measurements into string values
    .then(() => compileSrcsetAndSizes())

    // Apply attributes in chrome, then export the html and write it to a file
    .then(() => log('Build output html'))
    .then(() => driver.executeAsyncScript(processHtml, sizesAttributes))
    .then((processedHtml) => fs.writeFileSync(dstFolder + 'index.html', processedHtml))

    // Close the browser
    .then(() => {
      driver.quit()
      next();
    })

    // Handle errors
    .catch(err => {
      log('Error: Something went wrong. ' + err.message);
      console.log(err);
      driver.quit();
    })
}

/*
  Measure images at each media query
 */
function measureImagesInBrowser() {
  return new Promise(resolve => {
    log('Get measurements');

    // Take measurements of all the images at each mediaQuery
    let p = Promise.resolve();

    const measurementWidths = [];

    // Extend the promise chain for each query
    MEDIA_QUERIES.forEach(query => {
      const maxQuery = query--;
      // Resize the window to this maxQuery
      p = p.then(() => setWindowSize(maxQuery, 800))
        .then(() => log(`Measure images at ${maxQuery} pixels window width`))

        // Give it a chance to re-render
        .then(() => wait(100))

        // Take measurements of all the images at each mediaQuery
        .then(() => driver.executeAsyncScript(measureResponsiveImages, maxQuery, files))

        /** TIP **
          Here we're only measuring at the beginning of each media query range.
          You should measure at multiple points within a media query, saving the vw, px width
          Then compare those values within a media query to calculate whether the image is
          actually a pixel with, viewwidth, or calc.

          Consider populating measurementWidths with a set of intermediary widths
          between MEDIA_QUERIES
        */

        // Save the measurements in this context for later
        .then((res) => {
          const {query: _query, measurements} = res;

          for (const id in measurements) {
            // Get the measurement returned by the in-browser measuring script
            const measurement = measurements[id];

            imgSizesArrays[id] = imgSizesArrays[id] || {};
            imgSizesArrays[id][_query] = measurement;
          }
        })
    });

    return p.then(() => resolve());
  });
}

/*
  Compile the measurements taken earlier into the sizes attributes (which hint to the browser how the images render,
  and the variants generated earlier into the srcset attributes (which give the browser a list of sources to choose from))
 */
function compileSrcsetAndSizes(next) {
  log('Compile srcset and sizes attributes based on in-browser measurements and variants we generated earlier.');

  for (const id in imgSizesArrays) {

    /* Srcset Attribute */
    const srcsetArray = [];
    // Compile the srcset attribute from the variants we generated for this file
    const filename = imgIdToFileMap[id];
    const fileMetadata = files[filename];

    const variantsGenerated = fileMetadata.variants;

    variantsGenerated.forEach((variantWidth) => {
      const variantFilename = getVariantName(filename, variantWidth);
      const variantPath = variantFolderRelPath + variantFilename;

      srcsetArray.push(`${variantPath} ${variantWidth}w`)
    });

    const srcset = srcsetArray.join(', ');

    /* Sizes Attribute */
    const measurements = imgSizesArrays[id];
    const sizesAttrArray = [];

    for (const query in measurements) {
      if (query === MAX_VIEWABLE_QUERY) {

        // The max measurement will be appended to the end
        sizesAttrArray.push(`${measuredWidth}px`)
      } else {
        const measuredWith = measurements[query];

        /** TIP **
          If you find an image ends up with the same measurement in two or more adjacent media queries
          you can collapse them all into one
        */

        sizesAttrArray.push(`(max-width: ${query}px) ${measuredWith}`)
      }
    }
    const sizes = sizesAttrArray.join(', ');

    /** TIP **
      If you know the master image is already compressed, you may want to append it to the end of the list here.
      Otherwise you can also append it if you want to support large displays who are likely users that have faster network speeds
    */

    sizesAttributes[id] = {
      srcset,
      sizes
    }
  }
}

/* =========== Browser Utils ================================= */
// NOTE: These functions will be converted to strings and injected into the browser to be executed from there.

/*
  Waits for the document to fully render
 */
function waitUntilDocumentReady(cb) {
  const isDocumentReady = () => {
    if (document.readyState === 'complete') {
      cb();
    }
  }

  document.onreadystatechange = isDocumentReady;
  isDocumentReady();
}

/*
  Measures the widths of each <img> element on the page
  returns an object of shape
  {<img_id>: <width_measured>, <img_id>: <width_measured> }
*/
function measureResponsiveImages(query, files, cb) {
  const measurements = {};

  // Scrollbars will interfere with measurements
  const origOverflowVal = document.querySelector('html').style.overflow;
  document.querySelector('html').style.overflow = 'hidden'

  /** TIP **
    Here we only measure the pixel width, but an image could have a percent of it's parent
    margings, or be part of a complex layout where surrounding elements affect its
    rendered width in different ways. In a real-world example you should measure
    it's vw, and any other measurements at different points within the media query
    so that you can properly calculate its sizes attribute to more accurately hint
    what its rendered size will be
  */

  document.querySelectorAll('img').forEach((el) => {
    const id = el.getAttribute('id');
    const width = el.clientWidth;

    measurements[id] = width + 'px';
  });

  document.querySelector('html').style.overflow = origOverflowVal;

  cb({query, measurements});
}

/*
  Creates a map of all the <img> ids to their src images
*/
function mapIdsToFiles(cb) {
  const idToFileMap = {};

  document.querySelectorAll('img').forEach((el) => {
    const id = el.getAttribute('id');
    const src = el.getAttribute('src');
    const filename = src.replace(/^.*\//, ''); // This will return the `beach.jpg` in `images/beach.jpg`

    idToFileMap[id] = filename;
  });

  cb(idToFileMap);
}

/*
  Uses the browser as an html parser to generate output html
*/
function processHtml(responsiveAttributes, cb) {
  document.querySelectorAll('img').forEach((el) => {
    const id = el.getAttribute('id');
    const {srcset, sizes} = responsiveAttributes[id];

    el.setAttribute('sizes', sizes);
    el.setAttribute('srcset', srcset);
  });

  cb(document.querySelector('html').outerHTML)
}


/* =========== Generic Utils ================================= */
function log(msg) {
  console.log('\x1b[46m\x1b[30mlog: %s\x1b[0m', msg);
}

function getVariantName(filename, targetWidth) {
  return filename.slice(0, -4) + '-' + targetWidth + filename.slice(-4);
}

function wait(delay) {
  return driver.wait(new Promise(resolve => setTimeout(resolve, delay)), delay + 1)
}

function setWindowSize(width, height) {
  return driver.manage().window().setSize(width, height);
}
